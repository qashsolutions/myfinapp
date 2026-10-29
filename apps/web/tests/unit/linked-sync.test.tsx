import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Account, type Entry, openDb, type StackdDb } from "../../src/data/db.ts";
import { DEFAULT_CATEGORIES } from "../../src/data/defaults.ts";
import { engine } from "../../src/engine/bridge.ts";
import { billingState } from "../../src/features/billing/billing.ts";
import { renameEntry } from "../../src/features/entries/entryActions.ts";
import { linkErrorText } from "../../src/features/linking/linking.ts";
import {
  applySync,
  cursorKey,
  describeReport,
  LAST_SYNC_KEY,
  type SyncOut,
  type SyncTxn,
  syncConnection,
} from "../../src/features/linking/sync.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const NOW = new Date("2026-10-12T15:00:00Z");

const CHECKING: Account = {
  id: "acct-chk",
  label: "Checking",
  type: "checking",
  last4: "0000",
  institution: "First Platypus Bank",
  currency: "USD",
  created_at: "2026-09-01T00:00:00Z",
  linked: { connection_id: "bc1", account_id: "acc-chk" },
};
const CARD: Account = {
  ...CHECKING,
  id: "acct-cc",
  label: "Card",
  type: "credit_card",
  last4: "3333",
  linked: { connection_id: "bc1", account_id: "acc-cc" },
};

function txn(over: Partial<SyncTxn> = {}): SyncTxn {
  return {
    transaction_id: "t1",
    account_id: "acc-chk",
    date: "2026-10-10",
    direction: "out",
    amount_cents: 645,
    description: "STARBUCKS STORE 1234567890",
    pending: false,
    pending_transaction_id: null,
    ...over,
  };
}

function page(over: Partial<SyncOut> = {}): SyncOut {
  return {
    added: [],
    modified: [],
    removed: [],
    balances: [],
    next_cursor: "cur-1",
    has_more: false,
    ...over,
  };
}

function uploaded(over: Partial<Entry> = {}): Entry {
  return {
    id: "up-1",
    date: "2026-10-10",
    amount_cents: 645,
    direction: "out",
    merchant: "Coffee",
    clean_description: "COFFEE",
    raw_description: "COFFEE SHOP",
    category_id: "cat-dining",
    account_id: "acct-chk",
    source: "import",
    receipt_id: null,
    import_id: "imp-1",
    fingerprint: "fp-uploaded",
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-11T00:00:00Z",
    updated_at: "2026-10-11T00:00:00Z",
    ...over,
  };
}

async function seed(): Promise<StackdDb> {
  const db = openDb("u1");
  await db.categories.bulkPut(DEFAULT_CATEGORIES);
  await db.accounts.bulkPut([CHECKING, CARD]);
  return db;
}

describe("linked sync (chunk 3.3)", () => {
  let db: StackdDb;
  beforeEach(async () => {
    db = await seed();
  });

  it("adds new rows through the import rules: masked, fingerprinted, categorised", async () => {
    const report = await applySync(db, "bc1", page({ added: [txn()] }), NOW);
    expect(report).toMatchObject({ added: 1, updated: 0, adopted: 0, removed: 0 });
    const [e] = await db.entries.toArray();
    expect(e?.id).toBe("lnk-t1");
    expect(e?.source).toBe("linked");
    expect(e?.raw_description).toBe("STARBUCKS STORE ••7890");
    expect(e?.category_id).toBe("cat-dining");
    expect(e?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(e?.account_id).toBe("acct-chk");
    expect((await db.settings.get(cursorKey("bc1")))?.value).toBe("cur-1");
  });

  it("counts only what changed on this device (invariant 66)", async () => {
    const rows = [
      txn(),
      txn({ transaction_id: "t2", amount_cents: 1200 }),
      txn({ transaction_id: "p3", pending: true, amount_cents: 900 }),
    ];
    expect(await applySync(db, "bc1", page({ added: rows }), NOW)).toMatchObject({
      added: 3,
      updated: 0,
      removed: 0,
    });
    const before = await db.entries.toArray();
    // The bank sends the same rows again (a reset cursor, or "modified" with nothing new).
    const later = new Date("2026-10-12T16:00:00Z");
    const again = await applySync(db, "bc1", page({ modified: rows }), later);
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(describeReport(again)).toBe("");
    expect(await db.entries.toArray()).toEqual(before); // nothing rewritten either
    // A pending row posting is one update, not one new and one removed; a real change counts.
    const posted = await applySync(
      db,
      "bc1",
      page({
        removed: ["p3"],
        added: [txn({ transaction_id: "t3", pending_transaction_id: "p3", amount_cents: 900 })],
        modified: [txn({ transaction_id: "t2", amount_cents: 1250 }), txn()],
      }),
      later,
    );
    expect(posted).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(describeReport(posted)).toBe("2 updated");
    expect(describeReport({ added: 3, updated: 1, removed: 0, adopted: 0, transfers: 0 })).toBe(
      "3 new · 1 updated",
    );
  });

  it("keeps the person's names: a renamed row survives an update, new rows like it take the name", async () => {
    await applySync(db, "bc1", page({ added: [txn()] }), NOW);
    const first = (await db.entries.get("lnk-t1")) as Entry;
    await renameEntry(db, first, "Starbucks", true);
    await applySync(
      db,
      "bc1",
      page({
        modified: [txn({ amount_cents: 700 })],
        added: [txn({ transaction_id: "t2", date: "2026-10-11" })],
      }),
      NOW,
    );
    expect((await db.entries.get("lnk-t1"))?.merchant).toBe("Starbucks");
    expect((await db.entries.get("lnk-t1"))?.amount_cents).toBe(700);
    expect((await db.entries.get("lnk-t2"))?.merchant).toBe("Starbucks");
  });

  it("never counts an uploaded entry twice: same day, amount and direction is adopted", async () => {
    await db.entries.add(uploaded());
    const report = await applySync(db, "bc1", page({ added: [txn()] }), NOW);
    expect(report).toMatchObject({ added: 0, adopted: 1 });
    const all = await db.entries.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("up-1");
    expect(all[0]?.provider_txn_id).toBe("t1");
    expect(all[0]?.category_id).toBe("cat-dining"); // the user's own data wins
    // Seen again (a modified row), it updates the same entry.
    await applySync(db, "bc1", page({ modified: [txn({ amount_cents: 700 })] }), NOW);
    const after = await db.entries.toArray();
    expect(after).toHaveLength(1);
    expect(after[0]?.amount_cents).toBe(700);
  });

  it("two identical coffees the same day stay two entries", async () => {
    const report = await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "a" }), txn({ transaction_id: "b" })] }),
      NOW,
    );
    expect(report.added).toBe(2);
    const fps = (await db.entries.toArray()).map((e) => e.fingerprint).sort();
    expect(fps[1]).toBe(`${fps[0]}-2`);
  });

  it("a posted row replaces its pending version; removed rows go, with a tombstone", async () => {
    await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "p1", pending: true })] }),
      NOW,
    );
    expect((await db.entries.get("lnk-p1"))?.pending).toBe(true);
    await applySync(
      db,
      "bc1",
      page({
        removed: ["p1"],
        added: [txn({ transaction_id: "t9", pending_transaction_id: "p1", amount_cents: 650 })],
      }),
      NOW,
    );
    const all = await db.entries.toArray();
    expect(all.map((e) => [e.id, e.pending, e.amount_cents])).toEqual([["lnk-t9", false, 650]]);
    expect(await db.tombstones.toArray()).toEqual([
      expect.objectContaining({ table: "entries", id: "lnk-p1" }),
    ]);
  });

  it("a posted row keeps what the person did to its pending row (October 25, 2026)", async () => {
    await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "p1", pending: true, amount_cents: 2000 })] }),
      NOW,
    );
    await db.entries.update("lnk-p1", {
      category_id: "cat-groceries",
      merchant: "Coffee with Sam",
      renamed: true,
      note: "team treat",
      tags: ["work"],
      not_counted: true,
      receipt_id: "rc-1",
    });
    await db.receipts.add({
      id: "rc-1",
      entry_id: "lnk-p1",
      file_id: null,
      status: "confirmed",
      purge_after: null,
      purged_at: null,
      created_at: "2026-10-10T00:00:00Z",
      updated_at: "2026-10-10T00:00:00Z",
    });
    await applySync(
      db,
      "bc1",
      page({
        removed: ["p1"],
        added: [txn({ transaction_id: "t9", pending_transaction_id: "p1", amount_cents: 2000 })],
      }),
      NOW,
    );
    expect(await db.entries.get("lnk-p1")).toBeUndefined();
    expect(await db.entries.get("lnk-t9")).toMatchObject({
      pending: false,
      category_id: "cat-groceries",
      merchant: "Coffee with Sam",
      renamed: true,
      note: "team treat",
      tags: ["work"],
      not_counted: true,
      receipt_id: "rc-1",
    });
    expect(await db.receipts.get("rc-1")).toMatchObject({ entry_id: "lnk-t9" });
  });

  it("a row the bank removes takes its receipt and photo with it", async () => {
    await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
    await db.entries.update("lnk-t1", { receipt_id: "rc-1" });
    await db.files.add({
      id: "f-rc-1",
      kind: "receipt",
      import_id: null,
      name: "receipt.jpg",
      type: "image/jpeg",
      size: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      created_at: "2026-10-10T00:00:00Z",
    });
    await db.receipts.add({
      id: "rc-1",
      entry_id: "lnk-t1",
      file_id: "f-rc-1",
      status: "confirmed",
      purge_after: null,
      purged_at: null,
      created_at: "2026-10-10T00:00:00Z",
      updated_at: "2026-10-10T00:00:00Z",
    });
    await applySync(db, "bc1", page({ removed: ["t1"] }), NOW);
    expect(await db.entries.count()).toBe(0);
    expect(await db.receipts.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
  });

  it("a posted transfer stays paired with the other side", async () => {
    await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "p1", pending: true, amount_cents: 2000 })] }),
      NOW,
    );
    await db.entries.add(
      uploaded({ id: "card-pay", account_id: "acct-cc", direction: "in", amount_cents: 2000 }),
    );
    await db.entries.update("lnk-p1", {
      is_transfer: true,
      category_id: null,
      transfer_pair_id: "card-pay",
    });
    await db.entries.update("card-pay", { is_transfer: true, transfer_pair_id: "lnk-p1" });
    await applySync(
      db,
      "bc1",
      page({
        removed: ["p1"],
        added: [txn({ transaction_id: "t9", pending_transaction_id: "p1", amount_cents: 2000 })],
      }),
      NOW,
    );
    expect(await db.entries.get("lnk-t9")).toMatchObject({
      is_transfer: true,
      transfer_pair_id: "card-pay",
    });
    expect(await db.entries.get("card-pay")).toMatchObject({
      is_transfer: true,
      transfer_pair_id: "lnk-t9",
    });
  });

  describe("a split linked entry (October 25, 2026)", () => {
    /** Split $5.00 off the synced $20.00 coffee, the way the entry editor does. */
    async function splitCoffee(parentId: string, legacy = false) {
      const parent = (await db.entries.get(parentId)) as Entry;
      await db.entries.update(parentId, { amount_cents: parent.amount_cents - 500 });
      const { provider_txn_id, pending, ...rest } = parent;
      await db.entries.add({
        ...rest,
        // Parts split before this fix copied the bank's id
        ...(legacy ? { provider_txn_id, pending } : {}),
        id: "part-1",
        amount_cents: 500,
        category_id: "cat-dining",
        split_parent_id: parentId,
        fingerprint: undefined,
      });
    }
    const amounts = async () =>
      (await db.entries.toArray())
        .map((e) => [e.id, e.amount_cents, e.split_parent_id, e.provider_txn_id ?? null])
        .sort();

    it("the bank's new amount lands on the entry, minus the part; the part keeps its $5", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1", true);
      await applySync(db, "bc1", page({ modified: [txn({ amount_cents: 2200 })] }), NOW);
      expect(await amounts()).toEqual([
        ["lnk-t1", 1700, null, "t1"],
        ["part-1", 500, "lnk-t1", null],
      ]);
    });

    it("a posted row takes over its pending row's split", async () => {
      await applySync(
        db,
        "bc1",
        page({ added: [txn({ transaction_id: "p1", pending: true, amount_cents: 2000 })] }),
        NOW,
      );
      await splitCoffee("lnk-p1");
      await applySync(
        db,
        "bc1",
        page({
          removed: ["p1"],
          added: [txn({ transaction_id: "t9", pending_transaction_id: "p1", amount_cents: 2000 })],
        }),
        NOW,
      );
      expect(await amounts()).toEqual([
        ["lnk-t9", 1500, null, "t9"],
        ["part-1", 500, "lnk-t9", null],
      ]);
    });

    it("when the bank's amount no longer covers the part, the entry is whole again", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1");
      await applySync(db, "bc1", page({ modified: [txn({ amount_cents: 400 })] }), NOW);
      expect(await amounts()).toEqual([["lnk-t1", 400, null, "t1"]]);
    });

    /** Split $2.00 off the $5.00 part, the way the editor's Split on a part does. */
    async function splitPart() {
      const part = (await db.entries.get("part-1")) as Entry;
      await db.entries.update("part-1", { amount_cents: part.amount_cents - 200 });
      await db.entries.add({ ...part, id: "part-2", amount_cents: 200, split_parent_id: "part-1" });
    }

    it("a part split again: the sync subtracts every part, the bank's amount counted once", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1");
      await splitPart();
      await applySync(db, "bc1", page({ modified: [txn({ amount_cents: 2000 })] }), NOW);
      expect(await amounts()).toEqual([
        ["lnk-t1", 1500, null, "t1"],
        ["part-1", 300, "lnk-t1", null],
        ["part-2", 200, "part-1", null],
      ]);
      const total = (await db.entries.toArray()).reduce((s, e) => s + e.amount_cents, 0);
      expect(total).toBe(2000);
    });

    it("a posted row takes over its pending row's parts and their parts", async () => {
      await applySync(
        db,
        "bc1",
        page({ added: [txn({ transaction_id: "p1", pending: true, amount_cents: 2000 })] }),
        NOW,
      );
      await splitCoffee("lnk-p1");
      await splitPart();
      await applySync(
        db,
        "bc1",
        page({
          removed: ["p1"],
          added: [txn({ transaction_id: "t9", pending_transaction_id: "p1", amount_cents: 2000 })],
        }),
        NOW,
      );
      expect(await amounts()).toEqual([
        ["lnk-t9", 1500, null, "t9"],
        ["part-1", 300, "lnk-t9", null],
        ["part-2", 200, "part-1", null],
      ]);
    });

    it("a removed row takes its parts' parts with it too", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1");
      await splitPart();
      await applySync(db, "bc1", page({ removed: ["t1"] }), NOW);
      expect(await amounts()).toEqual([]);
    });

    it("when the bank's amount no longer covers every part, the parts' parts go too", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1");
      await splitPart();
      await applySync(db, "bc1", page({ modified: [txn({ amount_cents: 400 })] }), NOW);
      expect(await amounts()).toEqual([["lnk-t1", 400, null, "t1"]]);
    });

    it("a removed row takes its parts with it", async () => {
      await applySync(db, "bc1", page({ added: [txn({ amount_cents: 2000 })] }), NOW);
      await splitCoffee("lnk-t1");
      await applySync(db, "bc1", page({ removed: ["t1"] }), NOW);
      expect(await amounts()).toEqual([]);
    });
  });

  it("balances become today's anchors; a card's balance is what is owed", async () => {
    await applySync(
      db,
      "bc1",
      page({
        balances: [
          { account_id: "acc-chk", current_cents: 150050, type: "depository" },
          { account_id: "acc-cc", current_cents: 41000, type: "credit" },
          { account_id: "acc-ira", current_cents: 999, type: "investment" },
        ],
      }),
      NOW,
    );
    const anchors = (await db.balance_anchors.toArray()).sort((a, b) =>
      a.account_id.localeCompare(b.account_id),
    );
    expect(anchors.map((a) => [a.account_id, a.balance_cents, a.source, a.as_of])).toEqual([
      ["acct-cc", -41000, "linked", "2026-10-12"],
      ["acct-chk", 150050, "linked", "2026-10-12"],
    ]);
  });

  it("a card payment from checking pairs with the card's payment as a transfer", async () => {
    const report = await applySync(
      db,
      "bc1",
      page({
        added: [
          txn({ transaction_id: "out", amount_cents: 20000, description: "PAYMENT TO CARD 3333" }),
          txn({
            transaction_id: "in",
            account_id: "acc-cc",
            direction: "in",
            amount_cents: 20000,
            date: "2026-10-11",
            description: "PAYMENT - THANK YOU",
          }),
        ],
      }),
      NOW,
    );
    expect(report.transfers).toBeGreaterThan(0);
    const all = await db.entries.toArray();
    expect(all.every((e) => e.is_transfer && e.category_id === null)).toBe(true);
    expect(all[0]?.transfer_pair_id).toBe(all[1]?.id);
  });

  it("a split part is never taken as the other side of a transfer", async () => {
    // A card credit of $150 split by hand into $100 + a $50 part; the checking payment of $50
    // must not pair with the part (the part would drop out of the month).
    await db.entries.bulkAdd([
      uploaded({ id: "card-parent", account_id: "acct-cc", direction: "in", amount_cents: 10000 }),
      uploaded({
        id: "card-part",
        account_id: "acct-cc",
        direction: "in",
        amount_cents: 5000,
        split_parent_id: "card-parent",
        fingerprint: undefined,
      }),
    ]);
    await applySync(
      db,
      "bc1",
      page({
        added: [
          txn({ transaction_id: "pay", amount_cents: 5000, description: "PAYMENT TO CARD 3333" }),
        ],
      }),
      NOW,
    );
    expect(await db.entries.get("card-part")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
    expect(await db.entries.get("lnk-pay")).toMatchObject({ transfer_pair_id: null });
  });

  it("both sides of a transfer posting in the same page stay paired", async () => {
    await applySync(
      db,
      "bc1",
      page({
        added: [
          txn({ transaction_id: "pa", pending: true, amount_cents: 20000 }),
          txn({
            transaction_id: "pb",
            account_id: "acc-cc",
            direction: "in",
            pending: true,
            amount_cents: 20000,
          }),
        ],
      }),
      NOW,
    );
    await db.entries.update("lnk-pa", {
      is_transfer: true,
      category_id: null,
      transfer_pair_id: "lnk-pb",
    });
    await db.entries.update("lnk-pb", {
      is_transfer: true,
      category_id: null,
      transfer_pair_id: "lnk-pa",
    });
    await applySync(
      db,
      "bc1",
      page({
        removed: ["pa", "pb"],
        added: [
          txn({ transaction_id: "ta", pending_transaction_id: "pa", amount_cents: 20000 }),
          txn({
            transaction_id: "tb",
            account_id: "acc-cc",
            direction: "in",
            pending_transaction_id: "pb",
            amount_cents: 20000,
          }),
        ],
      }),
      NOW,
    );
    expect(await db.entries.get("lnk-ta")).toMatchObject({
      is_transfer: true,
      transfer_pair_id: "lnk-tb",
    });
    expect(await db.entries.get("lnk-tb")).toMatchObject({
      is_transfer: true,
      transfer_pair_id: "lnk-ta",
    });
  });

  it("an edit saved while a sync is working survives it, and the bank's new amount still lands", async () => {
    await applySync(db, "bc1", page({ added: [txn()] }), NOW);
    const later = new Date("2026-10-12T16:00:00Z");
    // The real engine, with an edit landing on the second row's fingerprint: the first row was
    // already read for this page by then
    const real = engine.call.bind(engine);
    let n = 0;
    const edit = vi.spyOn(engine, "call").mockImplementation(async (rule, input) => {
      if (rule === "fingerprint.row" && ++n === 2)
        await db.entries.update("lnk-t1", {
          category_id: "cat-groceries",
          note: "for the party",
          updated_at: "2026-10-12T15:30:00Z",
        });
      return real(rule, input);
    });
    await applySync(
      db,
      "bc1",
      page({
        // added rows are read first, then modified ones
        added: [txn({ amount_cents: 700 })],
        modified: [txn({ transaction_id: "t2", amount_cents: 900, description: "BAKERY" })],
      }),
      later,
    );
    edit.mockRestore();
    expect(await db.entries.get("lnk-t1")).toMatchObject({
      amount_cents: 700,
      category_id: "cat-groceries",
      note: "for the party",
    });
    expect(await db.entries.get("lnk-t2")).toMatchObject({ amount_cents: 900 });
    expect((await db.settings.get(cursorKey("bc1")))?.value).toBe("cur-1");
  });

  it("a transfer is never paired with a row the same page removes", async () => {
    await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "gone", amount_cents: 3000, description: "ATM" })] }),
      NOW,
    );
    await applySync(
      db,
      "bc1",
      page({
        removed: ["gone"],
        added: [
          txn({
            transaction_id: "pay",
            account_id: "acc-cc",
            direction: "in",
            amount_cents: 3000,
            date: "2026-10-11",
            description: "PAYMENT - THANK YOU",
          }),
        ],
      }),
      NOW,
    );
    expect(await db.entries.get("lnk-gone")).toBeUndefined();
    expect(await db.tombstones.get(["entries", "lnk-gone"])).toBeDefined();
    expect(await db.entries.get("lnk-pay")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
  });

  it("a row the bank removes lets its transfer partner count again", async () => {
    await applySync(
      db,
      "bc1",
      page({ added: [txn({ transaction_id: "gone", amount_cents: 3000 })] }),
      NOW,
    );
    await db.entries.add(
      uploaded({
        id: "kept",
        account_id: "acct-cc",
        direction: "in",
        amount_cents: 3000,
        is_transfer: true,
        category_id: null,
        transfer_pair_id: "lnk-gone",
      }),
    );
    await db.entries.update("lnk-gone", { is_transfer: true, transfer_pair_id: "kept" });
    await applySync(db, "bc1", page({ removed: ["gone"] }), NOW);
    expect(await db.entries.get("lnk-gone")).toBeUndefined();
    expect(await db.entries.get("kept")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
  });

  it("pages until done, sending only the cursor", async () => {
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T00:00:00Z",
      status: "ok",
      updates_available: false,
      last_synced_at: null,
    });
    api.linking.syncPages.bc1 = [
      { added: [txn({ transaction_id: "x1" })], has_more: true },
      { added: [txn({ transaction_id: "x2", date: "2026-10-09" })] },
    ];
    const report = await syncConnection(db, "bc1", NOW);
    expect(report).toMatchObject({ added: 2 });
    expect(api.linking.cursors.map((c) => c.cursor)).toEqual([
      null,
      expect.stringMatching(/^cur-/),
    ]);
    const bodies = api.calls.filter((c) => c.path === "/api/linking/bc1/sync").map((c) => c.body);
    for (const body of bodies) expect(Object.keys(body as object)).toEqual(["cursor"]);
  });

  it("shares one run when two syncs of the same connection overlap (return page + background)", async () => {
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T00:00:00Z",
      status: "ok",
      updates_available: false,
      last_synced_at: null,
    });
    api.linking.syncPages.bc1 = [{ added: [txn({ transaction_id: "x1" })] }];
    const [a, b] = await Promise.all([
      syncConnection(db, "bc1", NOW),
      syncConnection(db, "bc1", NOW),
    ]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ added: 1, updated: 0 });
    expect(api.calls.filter((c) => c.path === "/api/linking/bc1/sync")).toHaveLength(1);
    // Once it has finished, a later call runs again from the saved cursor.
    await syncConnection(db, "bc1", NOW);
    expect(api.linking.cursors.map((c) => c.cursor)).toEqual([
      null,
      expect.stringMatching(/^cur-/),
    ]);
  });

  it("pulls on open by itself, and the button checks again", async () => {
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T00:00:00Z",
      status: "ok",
      updates_available: false,
      last_synced_at: null,
    });
    api.linking.syncPages.bc1 = [{ added: [txn()] }, { added: [txn({ transaction_id: "t2" })] }];
    renderApp("/me/linking");
    // LinkedSync in the shell pulls on open: no tap needed.
    await waitFor(async () => expect(await db.entries.get("lnk-t1")).toBeTruthy());
    // Wait for that pull to finish (its last write), or the tap joins it instead of checking again.
    await waitFor(async () => expect(await db.settings.get(LAST_SYNC_KEY)).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    await userEvent.click(
      await screen.findByRole("button", { name: "Check for new transactions" }),
    );
    expect(await screen.findByText("1 new.")).toBeTruthy();
    expect(await db.entries.count()).toBe(2);
  });

  it("asks the server nothing on a device without a linked account", async () => {
    await db.accounts.bulkPut([
      { ...CHECKING, linked: null },
      { ...CARD, linked: null },
    ]);
    const api = installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.some((c) => c.path.startsWith("/api/linking"))).toBe(false);
  });
});

describe("revoke + sign in again (chunk 3.4)", () => {
  let db: StackdDb;
  beforeEach(async () => {
    db = await seed();
    billingState.lastUrl = null;
  });

  it("a paused connection offers Sign in again, which goes to the provider's page", async () => {
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T00:00:00Z",
      status: "login_required",
      updates_available: false,
      last_synced_at: null,
    });
    renderApp("/me/linking");
    expect(await screen.findByText(/Your bank needs you to sign in again/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy(); // leaving stays one tap
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() =>
      expect(billingState.lastUrl).toMatch(/^https:\/\/hosted\.plaid\.com\/link\/lr/),
    );
    const relink = api.calls.find((c) => c.path === "/api/linking/bc1/relink");
    expect(relink?.body ?? {}).toEqual({});
  });

  it("a sync that finds the bank wants a new sign-in says so, not a generic error", () => {
    expect(linkErrorText("login_required")).toMatch(/sign in again/);
  });

  it("accounts of a connection the server revoked stop being linked and keep their entries", async () => {
    await db.entries.add(uploaded({ id: "keep-me" }));
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    expect(api.linking.connections).toEqual([]); // revoked (60 days unused) since last open
    renderApp("/");
    await waitFor(async () =>
      expect((await db.accounts.toArray()).filter((a) => a.linked)).toHaveLength(0),
    );
    expect(await db.entries.get("keep-me")).toBeTruthy();
  });
});
