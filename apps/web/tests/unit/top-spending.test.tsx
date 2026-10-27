import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { todayIso } from "../../src/lib/format.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function entry(id: string, merchant: string, cents: number, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date: todayIso(),
    amount_cents: cents,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
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

describe("Biggest & most often (item 6, October 20, 2026)", () => {
  it("lists the biggest amounts and the merchants paid most often, transfers left out", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("c1", "Blue Bottle", 450),
      entry("c2", "blue bottle", 520),
      entry("c3", "BLUE BOTTLE ", 480),
      entry("tv", "Best Buy", 89900, { category_id: "cat-shopping" }),
      entry("sav", "To savings", 500000, { is_transfer: true, category_id: null }),
      entry("pay", "Paycheck", 300000, { direction: "in", category_id: "cat-paycheck" }),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: "Biggest & most often" });
    expect(await within(card).findByText("Blue Bottle, 3 times")).toBeInTheDocument();
    await user.click(card);

    const big = await screen.findByRole("region", { name: "Biggest single amounts" });
    const rows = await within(big).findAllByRole("link");
    expect(rows[0]).toHaveTextContent("Best Buy");
    expect(rows[0]).toHaveTextContent("−$899.00");
    expect(big).not.toHaveTextContent("To savings");
    expect(big).not.toHaveTextContent("Paycheck");

    const often = screen.getByRole("region", { name: "Paid most often" });
    const coffee = within(often).getByText("Blue Bottle").closest("details") as HTMLElement;
    await user.click(within(coffee).getByText("Blue Bottle"));
    expect(coffee).toHaveAttribute("open");
    expect(within(coffee).getByText("3 times", { exact: false })).toBeInTheDocument();
    expect(within(coffee).getByText("$14.50")).toBeInTheDocument();
    expect(within(coffee).getAllByRole("link")).toHaveLength(3);
  });
});
