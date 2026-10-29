/**
 * Defect round 3 (October 29, 2026), invariant 59: a Dexie transaction awaits only the
 * database. A real engine call goes to a Web Worker and answers in a later task, by when
 * IndexedDB has committed the transaction, so the next write inside it fails with "Transaction
 * has already completed". jsdom runs the engine inline, so this test makes it answer a task
 * later, the way the worker does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Entry, openDb } from "../../src/data/db.ts";
import { engine } from "../../src/engine/bridge.ts";
import { renameEntry } from "../../src/features/entries/entryActions.ts";

function entry(id: string, text: string): Entry {
  return {
    id,
    date: "2026-10-01",
    amount_cents: 1549,
    direction: "out",
    merchant: text,
    clean_description: text.toUpperCase(),
    raw_description: text,
    category_id: null,
    account_id: "acct-chk",
    source: "import",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

/** The engine answers in a later task, as the worker does in a browser. */
function engineLikeAWorker() {
  const call = engine.call.bind(engine);
  return vi.spyOn(engine, "call").mockImplementation(async (rule, input) => {
    await new Promise((r) => setTimeout(r, 5));
    return call(rule, input);
  });
}

describe("a transaction awaits only the database", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renaming every entry like this one works when the engine answers later", async () => {
    const db = openDb("u1");
    await db.entries.bulkAdd([
      entry("a", "NETFLIX.COM"),
      entry("b", "Netflix"),
      entry("c", "HULU"),
    ]);
    engineLikeAWorker();
    await renameEntry(db, (await db.entries.get("a")) as Entry, "Movies", true);
    expect((await db.entries.get("a"))?.merchant).toBe("Movies");
    expect((await db.entries.get("b"))?.merchant).toBe("Movies");
    expect((await db.entries.get("c"))?.merchant).toBe("HULU");
    expect((await db.merchant_names.toArray()).map((n) => n.name)).toEqual(["Movies"]);
  });
});
