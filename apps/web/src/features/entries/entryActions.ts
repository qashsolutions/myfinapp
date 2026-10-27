/**
 * Swipe actions on an entry (owner sign-off October 19, 2026, item 7; built October 20, 2026):
 * Rename (this one, or every entry with the same bank text, kept as a name for future imports
 * and syncs) and Don't count (left out of every spending total, kept in balances and net worth).
 */

import { recordDeletion } from "../../data/backup/snapshot.ts";
import { type Entry, newId, type StackdDb } from "../../data/db.ts";

/** Entries with the same cleaned bank text as this one, itself excluded. */
export async function likeThis(db: StackdDb, entry: Entry): Promise<Entry[]> {
  const key = entry.clean_description;
  if (!key) return [];
  return (await db.entries.toArray()).filter(
    (e) => e.id !== entry.id && e.clean_description === key,
  );
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
  await db.transaction("rw", db.entries, db.merchant_names, async () => {
    await db.entries.update(entry.id, { merchant: name, renamed: true, updated_at: stamp });
    if (!all || !entry.clean_description) return;
    const others = await likeThis(db, entry);
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

/** The saved names by cleaned bank text, for imports and syncs. */
export async function savedNames(db: StackdDb): Promise<Map<string, string>> {
  return new Map((await db.merchant_names.toArray()).map((n) => [n.match, n.name]));
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
