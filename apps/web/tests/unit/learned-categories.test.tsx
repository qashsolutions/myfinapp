/**
 * Fast-follow 7: the bundled category model fills in what the user rules and keyword table
 * missed (marked "model", never a guess for an unseen brand), and a corrected category can
 * become a rule that also moves past uncategorized entries.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { prepareRows } from "../../src/features/imports/importFlow.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function row(n: number, description: string, cents: number) {
  return { row: n, date: "2026-10-05", description, amount_cents: cents, balance_cents: null };
}

function entry(id: string, merchant: string, category: string | null): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: 1250,
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
    is_recurring: false,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
  };
}

describe("learned categories (fast-follow 7)", () => {
  it("the model fills gaps after rules and keywords, and abstains on unseen brands", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.merchant_rules.put({
      id: "r1",
      match: "WINCO",
      category_id: "cat-shopping",
      created_at: "2026-10-01T00:00:00Z",
    });
    const prepared = await prepareRows(db, "acct-cash", [
      row(1, "TST* PANDA EXPRESS 2203 DALLAS TX", -1462), // model: dining
      row(2, "POS DEBIT WINCO FOODS #44", -8417), // the user's rule wins over the model
      row(3, "TRADER JOES #512", -2210), // the keyword table wins
      row(4, "MUBI", -1199), // a brand the model never saw: stays uncategorized
      row(5, "ACME PAYROLL", 240000), // money in is never model-categorized
    ]);
    const by = (n: number) => prepared.rows.find((r) => r.row === n);
    expect(by(1)).toMatchObject({ category_id: "cat-dining", matched_by: "model" });
    expect(by(2)).toMatchObject({ category_id: "cat-shopping", matched_by: "user" });
    expect(by(3)).toMatchObject({ category_id: "cat-groceries", matched_by: "keyword" });
    expect(by(4)).toMatchObject({ category_id: null, matched_by: null });
    expect(by(5)?.matched_by).not.toBe("model");
  });

  it("a corrected category can become a rule that also moves past uncategorized entries", async () => {
    installFakeApi({ session: readySession() });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("e1", "BLUE BOTTLE 0042", null),
      entry("e2", "Blue Bottle 0042", null),
      entry("e3", "BLUE BOTTLE 0042", "cat-fun"), // already categorized: left alone
    ]);
    const user = userEvent.setup();
    renderApp("/entries/e1");
    await screen.findByRole("heading", { level: 1, name: "Edit entry" });
    const chips = screen.getByRole("group", { name: "Category" });
    await user.click(await within(chips).findByRole("radio", { name: "Dining" }));
    const offer = await screen.findByRole("switch", {
      name: "Always put BLUE BOTTLE 0042 in Dining",
    });
    await user.click(offer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });
    await waitFor(async () => expect((await db.entries.get("e2"))?.category_id).toBe("cat-dining"));
    expect((await db.entries.get("e1"))?.category_id).toBe("cat-dining");
    expect((await db.entries.get("e3"))?.category_id).toBe("cat-fun");
    expect(await db.merchant_rules.toArray()).toMatchObject([
      { match: "BLUE BOTTLE 0042", category_id: "cat-dining" },
    ]);
  });

  it("no offer when the category is unchanged, so rules only come from real corrections", async () => {
    installFakeApi({ session: readySession() });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("e1", "BLUE BOTTLE 0042", "cat-dining"));
    renderApp("/entries/e1");
    await screen.findByRole("heading", { level: 1, name: "Edit entry" });
    expect(screen.queryByRole("switch", { name: /Always put/ })).toBeNull();
  });
});
