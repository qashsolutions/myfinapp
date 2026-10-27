import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { todayIso } from "../../src/lib/format.ts";
import { emitMoment } from "../../src/moments/bus.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function monthsAgo(back: number, day: number): string {
  const [y, m] = todayIso().split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - back, day)).toISOString().slice(0, 10);
}

function entry(id: string, date: string, cents: number, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant: id,
    clean_description: id.toUpperCase(),
    raw_description: null,
    category_id: "cat-dining",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

describe("one place for each thing (October 23, 2026)", () => {
  it("/entries opens Money in & out on Transactions", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("Blue Bottle", todayIso(), 450));
    installFakeApi({ session: readySession() });
    renderApp("/entries");
    expect(await screen.findByRole("heading", { level: 1, name: "Money in & out" })).toBeVisible();
    expect(await screen.findByRole("radio", { name: "Transactions" })).toBeChecked();
    expect(await screen.findByText("Blue Bottle")).toBeInTheDocument();
  });

  it("category rules and saved names live on Categories, and can be removed there", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.merchant_rules.add({
      id: "r1",
      match: "BLUE BOTTLE",
      category_id: "cat-dining",
      created_at: "x",
    });
    await db.merchant_names.add({
      id: "n1",
      match: "AMZN MKTP US",
      name: "Amazon",
      created_at: "x",
      updated_at: "x",
    });
    installFakeApi({ session: readySession() });
    renderApp("/me/categories");
    const rules = await screen.findByRole("region", { name: "Your rules" });
    expect(rules).toHaveTextContent("BLUE BOTTLE");
    expect(rules).toHaveTextContent("→ Dining");
    expect(screen.getByRole("region", { name: "Your names" })).toHaveTextContent("Amazon");
    await user.click(within(rules).getByRole("button", { name: /BLUE BOTTLE/ }));
    await waitFor(async () => expect(await db.merchant_rules.count()).toBe(0));
  });

  it("Insights' Money in & out card shows the months behind this one, not Home's number again", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("pay1", monthsAgo(1, 2), 300000, { direction: "in", category_id: "cat-paycheck" }),
      entry("rent1", monthsAgo(1, 3), 100000),
      entry("pay0", monthsAgo(0, 1), 300000, { direction: "in", category_id: "cat-paycheck" }),
      entry("rent0", monthsAgo(0, 1), 100000),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: "Money in & out" });
    // (3,000 − 1,000) × 2 ÷ 2 months with entries
    await waitFor(() => expect(card).toHaveTextContent("About $2,000.00 a month kept"));
    expect(within(card).getByText("Kept")).toBeInTheDocument();
  });

  it("the 'running higher than usual' nudge links to where the facts are", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    act(() => emitMoment("spending_up", { category: "Dining" }, "cat-dining"));
    const link = await screen.findByRole("link", { name: "See where" });
    expect(link).toHaveAttribute("href", "/money");
  });
});
