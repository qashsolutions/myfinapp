/**
 * Subscriptions (owner decision, October 27, 2026): confirmed bills counted as subscriptions,
 * each with its yearly cost from `recurring.yearly_cost`, when it renews and how to cancel.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, type RecurringSeries, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function series(id: string, label: string, over: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    id,
    payee: label.toUpperCase(),
    label,
    kind: "bill",
    expected_cents: 1549,
    interval: "monthly",
    next_date: "2026-10-20",
    status: "confirmed",
    source: "detected",
    account_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function entry(id: string, date: string, merchant: string, category: string): Entry {
  return {
    id,
    date,
    amount_cents: 1549,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: true,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  } as Entry;
}

describe("Subscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts subscriptions by category or the person's call, a year at a time, and cancels nothing", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.recurring_series.bulkAdd([
      series("s-netflix", "Netflix"),
      series("s-cloud", "Cloud", {
        expected_cents: 999,
        interval: "yearly",
        next_date: "2026-10-11",
      }),
      series("s-gym", "Gym", { expected_cents: 2500, interval: "biweekly", source: "manual" }),
      series("s-rent", "Rent", { expected_cents: 165000 }),
      series("s-pay", "Payroll", { kind: "income", expected_cents: 240000 }),
    ]);
    await db.entries.bulkAdd([
      entry("e1", "2026-08-20", "Netflix", "cat-groceries"),
      entry("e2", "2026-09-20", "Netflix", "cat-subscriptions"), // the latest one decides
      entry("e3", "2025-10-11", "Cloud", "cat-subscriptions"),
      entry("e4", "2026-09-25", "Rent", "cat-rent"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await user.click(await screen.findByRole("link", { name: "Subscriptions" }));

    const hero = await screen.findByRole("region", { name: "A year of subscriptions" });
    // Netflix 1549 × 12 = 18588, Cloud 999 × 1 = 999: 19587 a year, 19587 ÷ 12 = 1632.25 → 1632
    await waitFor(() => expect(hero).toHaveTextContent("$195.87 a year"));
    expect(hero).toHaveTextContent("Yearly");
    expect(hero).toHaveTextContent("$16.32 a month across 2 subscriptions");
    const list = screen.getByRole("region", { name: "Netflix" });
    expect(list).toHaveTextContent("$185.88 a year");
    expect(list).toHaveTextContent("$15.49 a month · $185.88 a year");
    expect(list).toHaveTextContent("$15.49 monthly · Renews in 10 days, Oct 20");
    expect(list).toHaveTextContent("In 10 days");
    expect(list).toHaveTextContent("Video streaming");
    expect(screen.getByRole("region", { name: "Cloud" })).toHaveTextContent(
      "Renews tomorrow, Oct 11",
    );
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["Netflix", "Cloud"]),
    );

    // The person's own call, both ways; income never shows
    expect(screen.queryByText(/Payroll/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Count Gym as a subscription" }));
    // Gym 2500 × 26 = 65000 leads; 65000 + 19587 = 84587
    await waitFor(() => expect(hero).toHaveTextContent("$845.87 a year"));
    expect((await db.recurring_series.get("s-gym"))?.subscription).toBe(true);
    await user.click(
      within(screen.getByRole("region", { name: "Netflix" })).getByRole("button", {
        name: "Not a subscription",
      }),
    );
    await waitFor(() => expect(hero).toHaveTextContent("$659.99 a year"));
    expect((await db.recurring_series.get("s-netflix"))?.subscription).toBe(false);

    // How to cancel: steps only; "I cancelled it" takes it off the bills, entries stay
    await user.click(
      within(screen.getByRole("region", { name: "Cloud" })).getByRole("button", {
        name: "How to cancel",
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Cancel Cloud" });
    expect(sheet).toHaveTextContent("Settings → your name → Subscriptions");
    expect(within(sheet).queryByRole("link")).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "I cancelled it" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Cloud is off your bills");
    expect(await db.recurring_series.get("s-cloud")).toBeUndefined();
    expect(await db.entries.get("e3")).toBeDefined();
    await waitFor(() => expect(hero).toHaveTextContent("$650.00 a year"));
    const stored = await db.computed_results.get("subscriptions:2026-10-10");
    expect(stored?.rules_version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
