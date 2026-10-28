/**
 * A split entry keeps the bank's amount minus its parts, and a part can be split again
 * (docs/invariants.md rule 1). Every reader that needs the parts or the bank's row back goes
 * through here: the bank sync, deleting an entry, recurring payees, upcoming bills.
 */

import type { Entry } from "../../data/db.ts";

/** Returns a lookup of every part under the given entry ids, all the way down. */
export function splitTree(entries: Iterable<Entry>): (roots: Iterable<string>) => Entry[] {
  const children = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.split_parent_id) continue;
    const list = children.get(e.split_parent_id) ?? [];
    list.push(e);
    children.set(e.split_parent_id, list);
  }
  return (roots) => {
    const found: Entry[] = [];
    const seen = new Set<string>(roots);
    const queue = [...seen];
    while (queue.length) {
      for (const child of children.get(queue.shift() as string) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        queue.push(child.id);
      }
    }
    return found;
  };
}

/**
 * The cents a removed part gives back to the entry it was split from: its own amount and every
 * part under it, so that entry and the parts left still add up to the bank's row (rule 1).
 */
export function centsBackToParent(part: Entry, itsParts: Entry[]): number {
  return itsParts.reduce((sum, p) => sum + p.amount_cents, part.amount_cents);
}

/**
 * The bank's rows: each entry that is not a part, at its own amount plus all its parts. For
 * readers that compare amounts with the bank's (recurring payees, matching upcoming bills).
 */
export function bankRows(entries: Entry[]): Entry[] {
  const partsOf = splitTree(entries);
  return entries
    .filter((e) => !e.split_parent_id)
    .map((e) => {
      const mine = partsOf([e.id]);
      if (mine.length === 0) return e;
      return { ...e, amount_cents: mine.reduce((s, p) => s + p.amount_cents, e.amount_cents) };
    });
}
