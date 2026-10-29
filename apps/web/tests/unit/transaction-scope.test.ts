/**
 * Defect round 3 (October 29, 2026), invariant 59: a Dexie transaction awaits only the
 * database. A real engine call goes to a Web Worker and answers in a later task, by when
 * IndexedDB has committed the transaction, so the next write inside it fails with "Transaction
 * has already completed". jsdom runs the engine inline, so this test makes it answer a task
 * later, the way the worker does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Entry, openDb } from "../../src/data/db.ts";
import { engine } from "../../src/engine/bridge.ts";
import { renameEntry } from "../../src/features/entries/entryActions.ts";
import { applySync } from "../../src/features/linking/sync.ts";

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

/**
 * Defect round 4 (October 29, 2026): the sweep again, kept as a guard. Every
 * `db.transaction(...)` body in the app may await only the database (`db.*`, `tx.*`) or these
 * helpers, each read and found to touch nothing but Dexie. A body that awaits anything else
 * (the engine, the network, crypto, a timer) fails here; do that work first, or read the new
 * helper and add it with its reason.
 */
const DEXIE_ONLY: Record<string, string> = {
  prunedBeforeOf: "snapshot.ts: one settings read",
  uniqueClashSkips: "snapshot.ts: runs the given Dexie write, catches ConstraintError",
  "table.get": "snapshot.ts merge: a Dexie table",
  deleteReceipts: "receipts.ts: receipts and files tables",
  deleteReceiptsOf: "receipts.ts: receipts by entry, then deleteReceipts",
  recordDeletion: "snapshot.ts: tombstones.bulkPut",
  giveBack: "AddEntrySheet: entries.where().modify()",
  releasePartners: "transfers.ts: entries.filter().modify()",
  addGoalEvent: "useGoals.ts: goal_events.add",
  ensureMilestones: "useGoals.ts: its own nested Dexie transaction",
  sharedGoals: "householdSync.ts: goals.where().toArray()",
  splitParents: "transfers.ts: entries.each()",
  storeFile: "files.ts: files.add",
  "Promise.all": "ownKinds.ts: two Dexie reads at once",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The callback body of each `.transaction(` call: balanced braces from the arrow on. */
function transactionBodies(text: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  for (const m of text.matchAll(/\.transaction\(/g)) {
    const arrow = text.indexOf("=>", m.index);
    const open = text.indexOf("{", arrow);
    const lineEnd = text.indexOf("\n", arrow);
    let body: string;
    if (open === -1 || open > lineEnd) body = text.slice(arrow, lineEnd);
    else {
      let depth = 0;
      let end = open;
      for (; end < text.length; end += 1) {
        if (text[end] === "{") depth += 1;
        else if (text[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      body = text.slice(open, end + 1);
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, body });
  }
  return out;
}

describe("every transaction awaits only the database (sweep, October 29, 2026)", () => {
  it("finds no transaction body that awaits the engine, the network, crypto or a timer", () => {
    const src = join(import.meta.dirname, "../../src");
    const found: string[] = [];
    let bodies = 0;
    for (const file of sourceFiles(src)) {
      for (const { line, body } of transactionBodies(readFileSync(file, "utf8"))) {
        bodies += 1;
        for (const [, callee] of body.matchAll(/await\s+([A-Za-z_$][\w.$]*)/g)) {
          if (!callee || callee.startsWith("db.") || callee.startsWith("tx.")) continue;
          if (callee in DEXIE_ONLY) continue;
          found.push(`${relative(src, file)}:${line} awaits ${callee}`);
        }
      }
    }
    expect(bodies).toBeGreaterThan(40); // the sweep saw the app's transactions
    expect(found).toEqual([]);
  });

  it("a linked sync page writes in one transaction while the engine answers later", async () => {
    const db = openDb("u1");
    await db.accounts.put({
      id: "acct-chk",
      label: "Checking",
      type: "checking",
      last4: "0000",
      institution: "First Platypus Bank",
      currency: "USD",
      created_at: "2026-09-01T00:00:00Z",
      linked: { connection_id: "bc1", account_id: "acc-chk" },
    });
    engineLikeAWorker();
    const row = (id: string, cents: number) => ({
      transaction_id: id,
      account_id: "acc-chk",
      date: "2026-10-10",
      direction: "out",
      amount_cents: cents,
      description: "COFFEE SHOP",
      pending: false,
      pending_transaction_id: null,
    });
    const report = await applySync(db, "bc1", {
      added: [row("t1", 645), row("t2", 700)],
      modified: [],
      removed: [],
      balances: [],
      next_cursor: "cur-1",
      has_more: false,
    });
    expect(report).toMatchObject({ added: 2 });
    expect(await db.entries.count()).toBe(2);
  });
});
