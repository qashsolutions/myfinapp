/**
 * Linked sync (chunk 3.3; docs/security/linking.md). The device asks the server for changes
 * since its cursor; the server passes the provider's rows through and keeps nothing. Here they
 * go through the same rules as an uploaded statement: masked description, `fingerprint.row`,
 * the shared categoriser, and `cashflow.match_transfers` for transfer-looking rows. Nothing
 * counts twice:
 *
 * - a row seen before (same provider id) is updated in place; removed rows are deleted;
 * - a row whose fingerprint or (date, amount, direction) matches an uploaded entry in the same
 *   account adopts that entry instead of adding a new one;
 * - a posted row replaces its pending version (the provider removes the pending id).
 *
 * Entries made here have fixed ids (`lnk-<provider id>`), so two devices that both sync merge
 * through the encrypted backup without doubles. The cursor lives in `settings` and travels with
 * the entries it describes. Rule calls run first; every write lands in one Dexie transaction.
 */

import type { components } from "@stackd/api-client";
import { type ApiFailure, api, failureOf } from "../../data/api.ts";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import type {
  Account,
  BalanceAnchor,
  CardDetail,
  Direction,
  Entry,
  StackdDb,
} from "../../data/db.ts";
import { deleteReceiptsOf } from "../../data/receipts.ts";
import { engine, matchTransfers, type RuleEntry } from "../../engine/bridge.ts";
import { maskNumbers } from "../../importers/masking.ts";
import { addDaysIso } from "../../lib/dates.ts";
import { todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { savedNames } from "../entries/entryActions.ts";
import { splitTree } from "../entries/splits.ts";
import { releasePartners } from "../entries/transfers.ts";
import { loadCategorizer } from "../imports/importFlow.ts";
import { unlinkAccounts } from "./linking.ts";

export type SyncOut = components["schemas"]["SyncOut"];
export type SyncTxn = components["schemas"]["SyncTxn"];

export const cursorKey = (connectionId: string) => `linking.cursor.${connectionId}`;
export const LAST_SYNC_KEY = "linking.last_sync_at";
const MAX_ROUNDS = 20; // a first sync of a year of history is a few pages; this is a backstop

export interface SyncReport {
  added: number;
  updated: number;
  adopted: number;
  removed: number;
  transfers: number;
}

const emptyReport = (): SyncReport => ({
  added: 0,
  updated: 0,
  adopted: 0,
  removed: 0,
  transfers: 0,
});

export const linkedEntryId = (providerId: string) => `lnk-${providerId}`;

const inFlight = new Map<string, Promise<SyncReport | ApiFailure>>();

/**
 * Pull every page for one connection and apply it. Stops at the first failure. A second call
 * while one is running for the same connection (the return page and the background pull right
 * after linking) shares the running one, so the cursor is never read twice.
 */
export function syncConnection(
  db: StackdDb,
  connectionId: string,
  now: Date = new Date(),
): Promise<SyncReport | ApiFailure> {
  const running = inFlight.get(connectionId);
  if (running) return running;
  const job = runSync(db, connectionId, now).finally(() => inFlight.delete(connectionId));
  inFlight.set(connectionId, job);
  return job;
}

async function runSync(
  db: StackdDb,
  connectionId: string,
  now: Date,
): Promise<SyncReport | ApiFailure> {
  const total = emptyReport();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const saved = await db.settings.get(cursorKey(connectionId));
    const cursor = typeof saved?.value === "string" ? saved.value : null;
    const r = await api.POST("/api/linking/{connection_id}/sync", {
      params: { path: { connection_id: connectionId } },
      body: { cursor },
    });
    const failure = failureOf(r);
    if (failure) return failure;
    const out = r.data as SyncOut;
    const report = await applySync(db, connectionId, out, now);
    for (const k of Object.keys(total) as Array<keyof SyncReport>) total[k] += report[k];
    if (!out.has_more) break;
  }
  await pullCards(db, connectionId, now);
  await db.settings.put({
    key: LAST_SYNC_KEY,
    value: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return total;
}

/**
 * Chunk 3.5: the statement facts of this connection's linked cards (balance, dates, minimum,
 * limit, APR), stored on the device only. Asked only when a card from this connection is
 * linked here; a failure leaves the last facts in place (the transactions already synced).
 */
export async function pullCards(db: StackdDb, connectionId: string, now: Date = new Date()) {
  const cards = (await db.accounts.toArray()).filter(
    (a) => a.type === "credit_card" && a.linked?.connection_id === connectionId,
  );
  if (cards.length === 0) return;
  const r = await api.POST("/api/linking/{connection_id}/cards", {
    params: { path: { connection_id: connectionId } },
  });
  if (failureOf(r) || !r.data) return;
  const byProvider = new Map(cards.map((a) => [a.linked?.account_id, a.id]));
  const stamp = now.toISOString();
  const rows: CardDetail[] = [];
  for (const c of r.data.cards) {
    const accountId = byProvider.get(c.account_id);
    if (!accountId) continue; // a card the user didn't add to this device
    const { account_id: _provider, ...facts } = c;
    rows.push({ ...facts, account_id: accountId, updated_at: stamp });
  }
  if (rows.length) await db.card_details.bulkPut(rows);
}

interface Planned {
  put: Entry[];
  remove: string[];
  /** A posted entry whose pending partner also went this page: its pending partner's id. */
  lostPairs: Map<string, string>;
  receipts: Array<{ id: string; entry_id: string }>; // receipts moved to a posted entry
  anchors: BalanceAnchor[];
  report: SyncReport;
}

/** Apply one page. Exported for tests: the network part is `syncConnection`. */
export async function applySync(
  db: StackdDb,
  connectionId: string,
  out: SyncOut,
  now: Date = new Date(),
): Promise<SyncReport> {
  const stamp = now.toISOString();
  const today = todayIso(now);
  const accounts = (await db.accounts.toArray()).filter(
    (a) => a.linked?.connection_id === connectionId,
  );
  const byProviderAccount = new Map(accounts.map((a) => [a.linked?.account_id as string, a]));
  const plan: Planned = {
    put: [],
    remove: [],
    lostPairs: new Map(),
    receipts: [],
    anchors: [],
    report: emptyReport(),
  };
  const names = await savedNames(db);

  // Removed rows (including a pending row the bank has now posted).
  const removedParents = new Map<string, Entry>(); // provider id -> the removed entry
  for (const providerId of out.removed) {
    const gone = await db.entries.where("provider_txn_id").equals(providerId).toArray();
    plan.remove.push(...gone.map((e) => e.id));
    const parent = gone.find((e) => !e.split_parent_id);
    if (parent) removedParents.set(providerId, parent);
  }
  const bankCents = new Map<string, number>(); // entry id -> the bank's full amount
  const replaces = new Map<string, string>(); // a posted entry's id -> its pending entry's id

  const categorize = await loadCategorizer(db);
  const claimed = new Set<string>(); // entries adopted or written in this page
  const fingerprints = new Map<string, Set<string>>(); // account -> fingerprints used this page
  const hinted: Entry[] = [];

  for (const txn of [...out.added, ...out.modified]) {
    const account = byProviderAccount.get(txn.account_id);
    if (!account) continue; // a loan or brokerage account the device does not track
    const direction = txn.direction as Direction;
    const description = maskNumbers(txn.description.trim());
    const fp = await engine.call<{ fingerprint: string; clean_description: string }>(
      "fingerprint.row",
      {
        account_id: account.id,
        date: txn.date,
        amount_cents: direction === "out" ? -txn.amount_cents : txn.amount_cents,
        description,
      },
    );

    // The entry itself, never a split part (parts split before October 25, 2026 copied the id).
    const byProvider = (providerId: string) =>
      db.entries
        .where("provider_txn_id")
        .equals(providerId)
        .filter((e) => !e.split_parent_id)
        .first();
    const known =
      (await byProvider(txn.transaction_id)) ??
      (txn.pending_transaction_id ? await byProvider(txn.pending_transaction_id) : undefined);
    if (known && !plan.remove.includes(known.id)) {
      const fingerprint = await freeFingerprint(
        db,
        account,
        fp.fingerprint,
        known.id,
        fingerprints,
      );
      plan.put.push({
        ...known,
        date: txn.date,
        amount_cents: txn.amount_cents,
        direction,
        // A name the person gave is kept; otherwise a saved name, else the bank's text.
        merchant:
          known.source !== "linked" || known.renamed
            ? known.merchant
            : (names.get(fp.clean_description) ?? (description || known.merchant)),
        clean_description: fp.clean_description,
        raw_description: description,
        fingerprint,
        provider_txn_id: txn.transaction_id,
        pending: txn.pending,
        updated_at: stamp,
      });
      claimed.add(known.id);
      bankCents.set(known.id, txn.amount_cents);
      plan.report.updated += 1;
      continue;
    }

    const twin = await uploadedTwin(db, account, fp.fingerprint, txn, claimed);
    if (twin) {
      plan.put.push({
        ...twin,
        provider_txn_id: txn.transaction_id,
        pending: txn.pending,
        updated_at: stamp,
      });
      claimed.add(twin.id);
      plan.report.adopted += 1;
      continue;
    }

    const id = linkedEntryId(txn.transaction_id);
    const fingerprint = await freeFingerprint(db, account, fp.fingerprint, id, fingerprints);
    const cat = await categorize(description, direction);
    const entry: Entry = {
      id,
      date: txn.date,
      amount_cents: txn.amount_cents,
      direction,
      merchant:
        names.get(fp.clean_description) ??
        (description || (direction === "in" ? "Money in" : "Money out")),
      clean_description: fp.clean_description,
      raw_description: description,
      category_id: cat.is_transfer_hint ? null : cat.category_id,
      account_id: account.id,
      source: "linked",
      receipt_id: null,
      import_id: null,
      fingerprint,
      provider_txn_id: txn.transaction_id,
      pending: txn.pending,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: stamp,
      updated_at: stamp,
    };
    plan.put.push(entry);
    claimed.add(id);
    bankCents.set(id, txn.amount_cents);
    const pendingParent = txn.pending_transaction_id
      ? removedParents.get(txn.pending_transaction_id)
      : undefined;
    if (pendingParent) {
      replaces.set(id, pendingParent.id);
      await carryEdits(db, plan, pendingParent, entry);
    }
    plan.report.added += 1;
    if (cat.is_transfer_hint && !txn.pending) hinted.push(entry);
  }

  // Both sides of a transfer posted in this page: each pairs with the other's posted entry
  // (October 27, 2026); a side that didn't post is gone, and its partner counts again.
  const postedFor = new Map([...replaces].map(([posted, pending]) => [pending, posted]));
  for (const [postedId, pendingPartner] of plan.lostPairs) {
    const self = plan.put.find((e) => e.id === postedId);
    const partner = postedFor.get(pendingPartner);
    if (!self) continue;
    if (partner) self.transfer_pair_id = partner;
    else self.is_transfer = false;
  }

  await settleSplits(db, plan, bankCents, replaces, removedParents, stamp);

  const { others: paired, count } = await pairTransfers(db, hinted, plan.put);
  plan.report.transfers = count;

  for (const b of out.balances) {
    const account = byProviderAccount.get(b.account_id);
    if (!account) continue;
    // A card's "current" is what is owed: a negative balance for the device, like a statement.
    const cents = account.type === "credit_card" ? -b.current_cents : b.current_cents;
    plan.anchors.push({
      id: `lnk-bal-${account.id}-${today}`,
      account_id: account.id,
      as_of: today,
      balance_cents: cents,
      source: "linked",
      created_at: stamp,
    });
  }
  plan.report.removed = plan.remove.length;

  await db.transaction(
    "rw",
    [db.entries, db.balance_anchors, db.settings, db.tombstones, db.receipts, db.files],
    async () => {
      for (const r of plan.receipts)
        await db.receipts.update(r.id, { entry_id: r.entry_id, updated_at: stamp });
      if (plan.remove.length) {
        // A receipt a posted row did not take over goes with its entry (moved ones point on now)
        const kept = new Set(plan.put.map((e) => e.id));
        await deleteReceiptsOf(
          db,
          plan.remove.filter((id) => !kept.has(id)),
        );
        await db.entries.bulkDelete(plan.remove);
        await recordDeletion(db, "entries", plan.remove, now);
        await releasePartners(db, plan.remove, stamp); // before the puts, which relink posted rows
      }
      if (plan.put.length || paired.length) await db.entries.bulkPut([...plan.put, ...paired]);
      if (plan.anchors.length) await db.balance_anchors.bulkPut(plan.anchors);
      await db.settings.put({
        key: cursorKey(connectionId),
        value: out.next_cursor,
        updated_at: stamp,
      });
    },
  );
  return plan.report;
}

/**
 * A posted row keeps what the person did to its pending row: the category, their name, the
 * note and tags, Don't count, the transfer and recurring marks, and the receipt (moved to the
 * posted entry, as is the other side of a transfer). Its id follows the bank's new id, so two
 * devices that sync the same row agree on it.
 */
async function carryEdits(db: StackdDb, plan: Planned, pending: Entry, posted: Entry) {
  if (pending.category_id !== null || pending.is_transfer) posted.category_id = pending.category_id;
  if (pending.renamed) {
    posted.merchant = pending.merchant;
    posted.renamed = true;
  }
  if (pending.note) posted.note = pending.note;
  if (pending.tags?.length) posted.tags = pending.tags;
  if (pending.not_counted) posted.not_counted = true;
  posted.is_recurring = pending.is_recurring;
  if (pending.receipt_id) {
    posted.receipt_id = pending.receipt_id;
    plan.receipts.push({ id: pending.receipt_id, entry_id: posted.id });
  }
  if (pending.is_transfer) {
    posted.is_transfer = true;
    posted.transfer_pair_id = pending.transfer_pair_id;
    if (pending.transfer_pair_id) {
      const other =
        plan.put.find((e) => e.id === pending.transfer_pair_id) ??
        (await db.entries.get(pending.transfer_pair_id));
      if (other && !plan.remove.includes(other.id)) {
        other.transfer_pair_id = posted.id;
        other.updated_at = posted.updated_at;
        if (!plan.put.includes(other)) plan.put.push(other);
      } else {
        // The other side went too: it may have posted in this same page (relinked below).
        posted.transfer_pair_id = null;
        plan.lostPairs.set(posted.id, pending.transfer_pair_id);
      }
    }
  }
}

/**
 * A split entry is the bank's row minus its parts, so a sync that sets the bank's amount
 * subtracts the parts again; a posted row takes over its pending row's parts. When the bank's
 * amount no longer covers the parts, they go and the entry is whole again. Parts of a removed
 * entry that nothing took over go with it. Never two copies of the same money.
 */
async function settleSplits(
  db: StackdDb,
  plan: Planned,
  bankCents: Map<string, number>,
  replaces: Map<string, string>,
  removedParents: Map<string, Entry>,
  stamp: string,
): Promise<void> {
  const removing = new Set(plan.remove);
  const kept = new Set<string>();
  const parts: Entry[] = [];
  // A part can be split again, so parts are collected all the way down.
  const partsOf = splitTree(await db.entries.filter((e) => !!e.split_parent_id).toArray());
  for (const entry of plan.put) {
    const cents = bankCents.get(entry.id);
    if (cents === undefined) continue;
    const parents = new Set([entry.id, replaces.get(entry.id)].filter((x) => x !== undefined));
    const mine = partsOf(parents);
    if (mine.length === 0) continue;
    const split = mine.reduce((sum, e) => sum + e.amount_cents, 0);
    if (split >= cents) {
      for (const p of mine) removing.add(p.id);
      continue;
    }
    entry.amount_cents = cents - split;
    for (const p of mine) {
      const { provider_txn_id: _id, pending: _pending, ...rest } = p;
      kept.add(p.id);
      removing.delete(p.id);
      parts.push({
        ...rest,
        // a direct part follows the bank's row (a posted row takes over its pending row's parts);
        // a part's part keeps pointing at its own part
        split_parent_id: parents.has(p.split_parent_id as string) ? entry.id : p.split_parent_id,
        date: entry.date,
        direction: entry.direction,
        updated_at: stamp,
      });
    }
  }
  const orphaned = [...removedParents.values()].map((e) => e.id);
  for (const p of partsOf(orphaned)) if (!kept.has(p.id)) removing.add(p.id);
  plan.remove = [...removing];
  plan.put.push(...parts);
}

/** The fingerprint for this row, suffixed -2, -3… if another entry in the account holds it. */
async function freeFingerprint(
  db: StackdDb,
  account: Account,
  base: string,
  selfId: string,
  used: Map<string, Set<string>>,
): Promise<string> {
  const taken = used.get(account.id) ?? new Set<string>();
  used.set(account.id, taken);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (taken.has(candidate)) continue;
    const holder = await db.entries
      .where("[account_id+fingerprint]")
      .equals([account.id, candidate])
      .first();
    if (!holder || holder.id === selfId) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * An uploaded (or hand-entered) entry in the same account that is this transaction: the same
 * fingerprint, else the same date, amount and direction. Never one already tied to a provider
 * row, and never one claimed earlier in this page.
 */
async function uploadedTwin(
  db: StackdDb,
  account: Account,
  fingerprint: string,
  txn: SyncTxn,
  claimed: Set<string>,
): Promise<Entry | undefined> {
  const free = (e: Entry) => !e.provider_txn_id && e.source !== "linked" && !claimed.has(e.id);
  const same = await db.entries
    .where("[account_id+fingerprint]")
    .equals([account.id, fingerprint])
    .first();
  if (same && free(same)) return same;
  const sameDay = await db.entries
    .where("[account_id+date]")
    .equals([account.id, txn.date])
    .toArray();
  return sameDay
    .filter((e) => free(e) && e.amount_cents === txn.amount_cents && e.direction === txn.direction)
    .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id))[0];
}

/**
 * Transfer-looking rows (the keyword table's hint) paired by `cashflow.match_transfers` with the
 * other side in another account within 5 days. Both sides become transfers and drop out of In
 * and Out, exactly like a transfer confirmed after an import. Returns the pairs made and the
 * already-stored other sides to rewrite.
 */
async function pairTransfers(
  db: StackdDb,
  hinted: Entry[],
  page: Entry[],
): Promise<{ others: Entry[]; count: number }> {
  if (hinted.length === 0) return { others: [], count: 0 };
  const dates = hinted.map((e) => e.date).sort();
  const lo = addDaysIso(dates[0] as string, -5);
  const hi = addDaysIso(dates[dates.length - 1] as string, 5);
  const stored = await db.entries.where("date").between(lo, hi, true, true).toArray();
  const pool = new Map<string, Entry>();
  // Never a split part or a split parent (its amount is the bank's less its parts): pairing one
  // would take part of the money out of the month (October 27, 2026).
  const parents = new Set([...stored, ...page].map((e) => e.split_parent_id).filter(Boolean));
  for (const e of [...stored, ...page])
    if (!e.is_transfer && !e.pending && !e.split_parent_id && !parents.has(e.id)) pool.set(e.id, e);
  const asRule = (e: Entry): RuleEntry => ({
    id: e.id,
    date: e.date,
    amount_cents: e.amount_cents,
    direction: e.direction,
    is_transfer: false,
    category_id: null,
    category_kind: null,
    account_id: e.account_id,
  });
  const hintedIds = new Set(hinted.map((e) => e.id));
  const pairs = await matchTransfers([...pool.values()].map(asRule));
  const others: Entry[] = [];
  let count = 0;
  for (const pair of pairs) {
    const mine = hintedIds.has(pair.out_id)
      ? pair.out_id
      : hintedIds.has(pair.in_id)
        ? pair.in_id
        : null;
    if (!mine) continue;
    const otherId = mine === pair.out_id ? pair.in_id : pair.out_id;
    const self = page.find((e) => e.id === mine);
    const other = page.find((e) => e.id === otherId) ?? pool.get(otherId);
    if (!self || !other || self.is_transfer || other.is_transfer) continue;
    count += 1;
    Object.assign(self, { is_transfer: true, category_id: null, transfer_pair_id: other.id });
    const updatedOther = {
      ...other,
      is_transfer: true,
      category_id: null,
      transfer_pair_id: self.id,
      updated_at: self.updated_at,
    };
    const inPage = page.find((e) => e.id === otherId);
    if (inPage) Object.assign(inPage, updatedOther);
    else others.push(updatedOther);
  }
  return { others, count };
}

export const SYNC_EVERY_MS = 15 * 60 * 1000; // on open, then at most every 15 minutes (owner sign-off, October 27, 2026)

export interface SyncAllResult {
  report: SyncReport;
  failures: Array<{ connection_id: string; code: string }>;
}

/** Sync every connection that can be read (status ok). Skips ones waiting on the user. */
export async function syncAll(
  db: StackdDb,
  connections: Array<{ id: string; status: string }>,
  now: Date = new Date(),
): Promise<SyncAllResult> {
  const total = emptyReport();
  const failures: SyncAllResult["failures"] = [];
  for (const c of connections) {
    if (c.status !== "ok") continue;
    const result = await syncConnection(db, c.id, now);
    if ("status" in result && "code" in result) {
      failures.push({ connection_id: c.id, code: result.code });
      continue;
    }
    for (const k of Object.keys(total) as Array<keyof SyncReport>) total[k] += result[k];
  }
  return { report: total, failures };
}

/**
 * The background pull: only when this device has a linked account (so nothing is asked of the
 * server otherwise), and only when the last pull is old or the provider said there is news.
 */
export async function syncIfDue(
  db: StackdDb,
  now: Date = new Date(),
): Promise<SyncAllResult | null> {
  const linked = (await db.accounts.toArray()).some((a) => a.linked);
  if (!linked) return null;
  const r = await api.GET("/api/linking");
  if (failureOf(r)) return null;
  const connections = (r.data as components["schemas"]["LinkingOut"]).connections;
  // A connection the server no longer lists was revoked (60 days unused, or from another
  // device): its accounts keep every entry and simply stop being linked (chunk 3.4).
  const live = new Set(connections.map((c) => c.id));
  const gone = new Set(
    (await db.accounts.toArray())
      .map((a) => a.linked?.connection_id)
      .filter((id): id is string => typeof id === "string" && !live.has(id)),
  );
  for (const id of gone) await unlinkAccounts(db, id);
  const last = await db.settings.get(LAST_SYNC_KEY);
  const lastAt = typeof last?.value === "string" ? Date.parse(last.value) : 0;
  const stale = now.getTime() - lastAt >= SYNC_EVERY_MS;
  const news = connections.some((c) => c.updates_available);
  if (!stale && !news) return null;
  return syncAll(db, connections, now);
}

/** "3 new, 1 updated" for a status line; empty when nothing changed. */
export function describeReport(r: SyncReport): string {
  const parts: string[] = [];
  const fresh = r.added + r.adopted;
  if (fresh) parts.push(`${fresh} new`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.removed) parts.push(`${r.removed} removed`);
  return parts.join(", ");
}
