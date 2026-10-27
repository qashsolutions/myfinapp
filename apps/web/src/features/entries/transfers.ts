import type { Entry, StackdDb } from "../../data/db.ts";
import { addDays, matchTransfers, type RuleEntry } from "../../engine/bridge.ts";

const WINDOW_DAYS = 5;

/**
 * The other side of a transfer marked by hand (October 27, 2026; docs/invariants.md rule 2): the
 * entry in another account with the same amount the other way within 5 days, closest date first,
 * by the same rule import and bank sync use (`cashflow.match_transfers`). Only entries not
 * already a transfer, and never a split part. Null when the other side isn't recorded (cash, an
 * account not in Qash): then only this entry is marked.
 */
export async function findTransferPartner(db: StackdDb, entry: Entry): Promise<Entry | null> {
  const from = await addDays(entry.date, -WINDOW_DAYS);
  const to = await addDays(entry.date, WINDOW_DAYS);
  const nearby = await db.entries.where("date").between(from, to, true, true).toArray();
  const parents = new Set(nearby.map((e) => e.split_parent_id).filter(Boolean));
  const candidates = nearby.filter(
    (e) =>
      e.id !== entry.id &&
      e.account_id !== entry.account_id &&
      e.direction !== entry.direction &&
      e.amount_cents === entry.amount_cents &&
      !e.is_transfer &&
      !e.transfer_pair_id &&
      !e.split_parent_id &&
      !parents.has(e.id),
  );
  if (candidates.length === 0) return null;
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
  const pairs = await matchTransfers([entry, ...candidates].map(asRule), WINDOW_DAYS);
  const pair = pairs.find((p) => p.out_id === entry.id || p.in_id === entry.id);
  if (!pair) return null;
  const otherId = pair.out_id === entry.id ? pair.in_id : pair.out_id;
  return candidates.find((e) => e.id === otherId) ?? null;
}

/**
 * Marks entries as transfers by hand, each paired with its other side when one is recorded
 * (Sort your spending's "Transfer", October 27, 2026). Returns every entry it changed and an
 * undo that puts each back exactly: the mark, the pair and the category.
 */
export async function markTransfers(
  db: StackdDb,
  ids: string[],
  now: Date = new Date(),
): Promise<{ ids: string[]; undo: () => Promise<void> }> {
  const stamp = now.toISOString();
  const before = new Map<string, Pick<Entry, "is_transfer" | "transfer_pair_id" | "category_id">>();
  const keep = (e: Entry) => {
    if (!before.has(e.id))
      before.set(e.id, {
        is_transfer: e.is_transfer,
        transfer_pair_id: e.transfer_pair_id,
        category_id: e.category_id,
      });
  };
  for (const id of ids) {
    const entry = await db.entries.get(id);
    if (!entry || entry.is_transfer) continue;
    const partner = entry.transfer_pair_id ? null : await findTransferPartner(db, entry);
    await db.transaction("rw", db.entries, async () => {
      const self = await db.entries.get(id);
      if (!self || self.is_transfer) return;
      keep(self);
      const other = partner ? await db.entries.get(partner.id) : undefined;
      const pairs = !!other && !other.is_transfer && !other.transfer_pair_id;
      if (pairs && other) {
        keep(other);
        await db.entries.update(other.id, {
          is_transfer: true,
          category_id: null,
          transfer_pair_id: self.id,
          updated_at: stamp,
        });
      }
      await db.entries.update(self.id, {
        is_transfer: true,
        category_id: null,
        transfer_pair_id: pairs && other ? other.id : self.transfer_pair_id,
        updated_at: stamp,
      });
    });
  }
  return {
    ids: [...before.keys()],
    undo: async () => {
      const at = new Date().toISOString();
      await db.transaction("rw", db.entries, async () => {
        for (const [id, was] of before) await db.entries.update(id, { ...was, updated_at: at });
      });
    },
  };
}

/**
 * Entries that went (deleted by hand, with their account, or removed by the bank): a transfer
 * partner left behind is an ordinary entry again, so it counts in the month instead of being
 * left out silently (October 27, 2026; docs/invariants.md rule 2). Runs in the caller's
 * transaction when there is one.
 */
export async function releasePartners(
  db: StackdDb,
  goneIds: string[],
  stamp: string = new Date().toISOString(),
): Promise<void> {
  if (goneIds.length === 0) return;
  const gone = new Set(goneIds);
  await db.entries
    .filter((e) => !!e.transfer_pair_id && gone.has(e.transfer_pair_id) && !gone.has(e.id))
    .modify({ is_transfer: false, transfer_pair_id: null, updated_at: stamp });
}
