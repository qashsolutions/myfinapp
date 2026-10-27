import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { dismissUndo } from "../../src/features/entries/undoToast.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function entry(id: string, date: string, merchant: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date,
    amount_cents: 450,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: null,
    account_id: "acct-cash",
    source: "import",
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

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("b1", "2026-10-09", "Blue Bottle #12"),
    entry("b2", "2026-10-05", "BLUE BOTTLE #12"),
    entry("b3", "2026-10-02", "blue bottle #12"),
    entry("pay", "2026-10-01", "ACME PAYROLL", { direction: "in", amount_cents: 240000 }),
    entry("moved", "2026-10-08", "To savings", { is_transfer: true }),
    entry("done", "2026-10-07", "Corner Market", { category_id: "cat-groceries" }),
  ]);
  return db;
}

describe("Sort your spending (item 9, October 20, 2026)", () => {
  afterEach(() => dismissUndo());

  it("sorts one at a time, all alike at once with a rule, and finishes", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/review");
    const card = await screen.findByRole("region", { name: "To sort" });
    expect(within(card).getByText("Blue Bottle #12")).toBeInTheDocument();
    expect(screen.getByText("4 left")).toBeInTheDocument();
    const all = await within(card).findByRole("switch", {
      name: "Do the same for all 3 like this",
    });
    expect(all).toBeChecked();
    await user.click(within(card).getByRole("button", { name: /^Dining/ }));

    await waitFor(async () =>
      expect((await db.entries.bulkGet(["b1", "b2", "b3"])).map((e) => e?.category_id)).toEqual([
        "cat-dining",
        "cat-dining",
        "cat-dining",
      ]),
    );
    expect((await db.merchant_rules.toArray()).map((r) => [r.match, r.category_id])).toEqual([
      ["BLUE BOTTLE #12", "cat-dining"],
    ]);
    // Money in gets the money-in categories.
    const next = await screen.findByRole("region", { name: "To sort" });
    expect(await within(next).findByText("ACME PAYROLL")).toBeInTheDocument();
    expect(within(next).getByRole("button", { name: /^Paycheck/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText(/Done for now\. 1 skipped/)).toBeInTheDocument();
  });

  it("undo puts every sorted entry back and forgets the rule; transfers apply to all alike", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/review");
    const card = await screen.findByRole("region", { name: "To sort" });
    await within(card).findByRole("switch", { name: "Do the same for all 3 like this" });
    await user.click(within(card).getByRole("button", { name: /^Dining/ }));
    expect(await screen.findByText("3 sorted into Dining")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect(await db.merchant_rules.count()).toBe(0));
    expect((await db.entries.get("b2"))?.category_id).toBeNull();

    const again = await screen.findByRole("region", { name: "To sort" });
    await within(again).findByRole("switch", { name: "Do the same for all 3 like this" });
    await user.click(screen.getByRole("button", { name: "It's a transfer" }));
    await waitFor(async () =>
      expect((await db.entries.bulkGet(["b1", "b2", "b3"])).every((e) => e?.is_transfer)).toBe(
        true,
      ),
    );
  });

  it("a transfer marks and pairs its other side, and Undo puts both back", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.accounts.add({
      id: "acct-save",
      label: "Savings",
      type: "savings",
      last4: "4410",
      institution: null,
      currency: "USD",
      created_at: "2026-10-01T00:00:00Z",
    });
    await db.entries.bulkAdd([
      entry("out", "2026-10-08", "Online transfer", { amount_cents: 30000 }),
      entry("in", "2026-10-09", "Deposit", {
        amount_cents: 30000,
        direction: "in",
        account_id: "acct-save",
        category_id: "cat-other-income",
      }),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/review");
    await screen.findByRole("region", { name: "To sort" });
    await user.click(screen.getByRole("button", { name: "It's a transfer" }));
    await waitFor(async () =>
      expect(await db.entries.get("out")).toMatchObject({
        is_transfer: true,
        transfer_pair_id: "in",
      }),
    );
    expect(await db.entries.get("in")).toMatchObject({
      is_transfer: true,
      category_id: null,
      transfer_pair_id: "out",
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () =>
      expect(await db.entries.get("in")).toMatchObject({
        is_transfer: false,
        category_id: "cat-other-income",
        transfer_pair_id: null,
      }),
    );
    expect(await db.entries.get("out")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
  });
});
