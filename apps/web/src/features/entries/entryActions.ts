/**
 * Swipe actions on an entry (owner sign-off October 19, 2026, item 7; built October 20, 2026):
 * Rename (this one, or every entry with the same bank text, kept as a name for future imports
 * and syncs) and Don't count (left out of every spending total, kept in balances and net worth).
 */

import { recordDeletion } from "../../data/backup/snapshot.ts";
import { bankText, type Entry, newId, type StackdDb } from "../../data/db.ts";
import { merchantKey, merchantKeys } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";

/**
 * Entries of the same merchant as this one, itself excluded: the same merchant key of the bank's
 * text (owner, October 29, 2026: NETFLIX, netflix and Netflix.com are one; invariant 47).
 */
export async function likeThis(db: StackdDb, entry: Entry): Promise<Entry[]> {
  if (!entry.clean_description) return [];
  const key = await merchantKey(entry.clean_description);
  const rows = (await db.entries.toArray()).filter((e) => e.id !== entry.id && bankText(e));
  const keys = await merchantKeys(rows.map(bankText));
  return rows.filter((e) => keys.get(bankText(e)) === key);
}

/** Renames one entry, or every entry like it plus future imports and syncs when `all`. */
export async function renameEntry(
  db: StackdDb,
  entry: Entry,
  raw: string,
  all: boolean,
  now: Date = new Date(),
): Promise<void> {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) return;
  const stamp = now.toISOString();
  // The entries like this one are found first: finding them asks the engine, which answers from
  // a worker in a later task, and a transaction awaiting anything but the database commits
  // early ("Transaction has already completed"; invariant 59).
  const others = all && entry.clean_description ? await likeThis(db, entry) : [];
  await db.transaction("rw", db.entries, db.merchant_names, async () => {
    await db.entries.update(entry.id, { merchant: name, renamed: true, updated_at: stamp });
    if (!all || !entry.clean_description) return;
    for (const e of others)
      await db.entries.update(e.id, { merchant: name, renamed: true, updated_at: stamp });
    const existing = await db.merchant_names.where("match").equals(entry.clean_description).first();
    await db.merchant_names.put({
      id: existing?.id ?? newId(),
      match: entry.clean_description,
      name,
      created_at: existing?.created_at ?? stamp,
      updated_at: stamp,
    });
  });
}

export async function forgetName(db: StackdDb, id: string): Promise<void> {
  await db.transaction("rw", db.merchant_names, db.tombstones, async () => {
    await db.merchant_names.delete(id);
    await recordDeletion(db, "merchant_names", [id]);
  });
}

/**
 * The saved names by merchant key, for imports and syncs (look up a row's `merchant_key` from
 * `fingerprint.row`). Each name is stored with the bank text it was made from; the newest name
 * wins when two texts share a key.
 */
export async function savedNames(db: StackdDb): Promise<Map<string, string>> {
  const rows = (await db.merchant_names.toArray()).sort((a, b) =>
    compareText(a.updated_at, b.updated_at),
  );
  const keys = await merchantKeys(rows.map((n) => n.match));
  return new Map(rows.map((n) => [keys.get(n.match) as string, n.name]));
}

export async function setCounted(
  db: StackdDb,
  id: string,
  isCounted: boolean,
  now: Date = new Date(),
): Promise<void> {
  await db.entries.update(id, { not_counted: !isCounted, updated_at: now.toISOString() });
}

/**
 * Another entry that looks like the same charge: same date, amount and direction, neither a
 * transfer. Offered as "Looks like a duplicate?" so a double import is deleted, not hidden.
 */
export async function duplicateOf(db: StackdDb, entry: Entry): Promise<Entry | null> {
  if (entry.is_transfer) return null;
  const same = await db.entries.where("date").equals(entry.date).toArray();
  return (
    same.find(
      (e) =>
        e.id !== entry.id &&
        !e.is_transfer &&
        e.amount_cents === entry.amount_cents &&
        e.direction === entry.direction,
    ) ?? null
  );
}
