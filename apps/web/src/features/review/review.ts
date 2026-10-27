/**
 * Category review (owner sign-off October 19, 2026, item 9): what isn't sorted yet, one at a
 * time. Sorting can remember the choice as a category rule (the same rule "Always put X in Y"
 * writes), matched on the bank's text so a renamed entry still matches future imports.
 */

import { recordDeletion } from "../../data/backup/snapshot.ts";
import { type Entry, newId, type StackdDb } from "../../data/db.ts";
import { cleanDescription } from "../../engine/bridge.ts";

/** Entries waiting for a category: not a transfer, counted, not a split part. Newest first. */
export async function toReview(db: StackdDb): Promise<Entry[]> {
  const rows = await db.entries
    .filter((e) => e.category_id === null && !e.is_transfer && !e.not_counted)
    .toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** The text a rule matches on: the bank's text when there is one, else the name. */
export function ruleText(entry: Entry): string {
  return (entry.clean_description || entry.merchant).trim();
}

/** The other unsorted entries with the same bank text (by the rule's substring match), same direction. */
export async function alikeIds(db: StackdDb, entry: Entry): Promise<string[]> {
  const cleaned = await cleanDescription(ruleText(entry));
  if (!cleaned) return [];
  const out: string[] = [];
  for (const row of await toReview(db)) {
    if (row.id === entry.id || row.direction !== entry.direction) continue;
    if ((await cleanDescription(ruleText(row))).includes(cleaned)) out.push(row.id);
  }
  return out;
}

/** Marks one entry, or it and every unsorted entry like it, as not counted. Transfers go
 * through `entries/transfers.markTransfers`, which pairs the other side. */
export async function markAll(
  db: StackdDb,
  entry: Entry,
  change: { not_counted: true },
  all: boolean,
  now: Date = new Date(),
): Promise<string[]> {
  const ids = [entry.id, ...(all ? await alikeIds(db, entry) : [])];
  await db.entries
    .where("id")
    .anyOf(ids)
    .modify({ ...change, updated_at: now.toISOString() });
  return ids;
}

/**
 * Sorts one entry; with `remember`, also every unsorted entry like it, and future imports.
 * Returns what changed so it can be undone.
 */
export async function sortEntry(
  db: StackdDb,
  entry: Entry,
  categoryId: string,
  remember: boolean,
  now: Date = new Date(),
): Promise<{ ids: string[]; ruleId: string | null }> {
  const stamp = now.toISOString();
  const ids = [entry.id];
  let ruleId: string | null = null;
  if (remember) {
    const match = ruleText(entry);
    if (await cleanDescription(match)) {
      ids.push(...(await alikeIds(db, entry)));
      ruleId = newId();
      await db.merchant_rules.put({
        id: ruleId,
        match,
        category_id: categoryId,
        created_at: stamp,
      });
    }
  }
  await db.entries.where("id").anyOf(ids).modify({ category_id: categoryId, updated_at: stamp });
  return { ids, ruleId };
}

/** Puts entries back to unsorted and forgets the rule a sort made. */
export async function unsort(
  db: StackdDb,
  done: { ids: string[]; ruleId: string | null },
): Promise<void> {
  await db.entries.where("id").anyOf(done.ids).modify({ category_id: null });
  if (done.ruleId) {
    await db.merchant_rules.delete(done.ruleId);
    await recordDeletion(db, "merchant_rules", [done.ruleId]);
  }
}
