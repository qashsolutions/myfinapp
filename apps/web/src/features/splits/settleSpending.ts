/**
 * A payment I send to settle a split group is my spending (spec "Money counted once", S.6,
 * invariant 76): in the category I pick, by default the one of the group's largest bill that
 * came from one of my own entries. Offered on only when this device has no statement imports
 * and no linked accounts: with either, the bank shows the payment itself and adding it here
 * would count it twice.
 */

import { recordDeletion } from "../../data/backup/snapshot.ts";
import { type Entry, newId, type StackdDb } from "../../data/db.ts";
import { todayIso } from "../../lib/format.ts";

export const settleRef = (groupId: string, settlementId: string) => `${groupId}:${settlementId}`;

export async function settleDefaults(
  db: StackdDb,
  groupId: string,
): Promise<{ on: boolean; categoryId: string | null }> {
  const imported = await db.statement_imports.count();
  const linked = (await db.accounts.toArray()).some((a) => Boolean(a.linked));
  const mine = (await db.entries.toArray()).filter(
    (e) => e.split_bill?.startsWith(`${groupId}:`) && !e.not_counted && e.category_id,
  );
  const largest = mine.reduce<Entry | null>(
    (best, e) => (!best || e.amount_cents > best.amount_cents ? e : best),
    null,
  );
  return { on: imported === 0 && !linked, categoryId: largest?.category_id ?? null };
}

/** The entry for a payment I sent: money out today, "Paid <name>", in the Cash account. */
export async function addSettleSpending(
  db: StackdDb,
  p: {
    groupId: string;
    settlementId: string;
    cents: number;
    to: string;
    categoryId: string | null;
  },
): Promise<string> {
  const accounts = await db.accounts.toArray();
  const account = accounts.find((a) => a.type === "cash") ?? accounts[0];
  const now = new Date().toISOString();
  const merchant = `Paid ${p.to}`;
  const entry: Entry = {
    id: newId(),
    date: todayIso(),
    amount_cents: p.cents,
    direction: "out",
    merchant,
    clean_description: merchant,
    raw_description: null,
    category_id: p.categoryId,
    account_id: account?.id ?? "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    split_settle: settleRef(p.groupId, p.settlementId),
    created_at: now,
    updated_at: now,
  };
  await db.entries.add(entry);
  return entry.id;
}

/** Undoing a payment (S.7) takes its spending entry with it; a sync can't bring it back. */
export async function removeSettleSpending(
  db: StackdDb,
  groupId: string,
  settlementId: string,
): Promise<number> {
  const ref = settleRef(groupId, settlementId);
  const ids = (await db.entries.toArray()).filter((e) => e.split_settle === ref).map((e) => e.id);
  if (ids.length === 0) return 0;
  await db.entries.bulkDelete(ids);
  await recordDeletion(db, "entries", ids);
  return ids.length;
}
