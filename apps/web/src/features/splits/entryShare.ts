/**
 * Money counted once (invariant 76): an entry shared in a split group keeps only the person's
 * own share in its category; the rest becomes a part "Owed to me" that is never counted, so the
 * parts still add up to the bank's row (rule 1) and spending shows only what was really theirs.
 */

import type { Entry, StackdDb } from "../../data/db.ts";
import { newId } from "../../data/db.ts";

export const OWED_TO_ME = "Owed to me";

/** Split `entryId` into my share and an "Owed to me" part. False when it can't be shared (not
 * money out, a transfer, a part already, already shared, or my share isn't below the total). */
export async function shareEntry(
  db: StackdDb,
  entryId: string,
  myShareCents: number,
  billRef: string,
): Promise<boolean> {
  return db.transaction("rw", db.entries, async () => {
    const e = await db.entries.get(entryId);
    if (e?.direction !== "out" || e.is_transfer || e.split_parent_id || e.split_bill) return false;
    const shared = await db.entries
      .filter((x) => x.split_parent_id === e.id && Boolean(x.split_bill))
      .count();
    if (shared > 0) return false;
    const rest = e.amount_cents - Math.max(0, myShareCents);
    if (myShareCents < 0 || rest <= 0) return false;
    const now = new Date().toISOString();
    if (myShareCents === 0) {
      // None of it was mine: the whole entry is owed back, kept in the balance only.
      await db.entries.put({ ...e, not_counted: true, split_bill: billRef, updated_at: now });
      return true;
    }
    const part: Entry = {
      ...e,
      id: newId(),
      amount_cents: rest,
      merchant: OWED_TO_ME,
      renamed: true,
      split_parent_id: e.id,
      split_bill: billRef,
      not_counted: true,
      receipt_id: null,
      note: null,
      tags: [],
      created_at: now,
      updated_at: now,
    };
    part.fingerprint = undefined;
    delete part.provider_txn_id;
    delete part.pending;
    await db.entries.put({
      ...e,
      amount_cents: myShareCents,
      split_bill: billRef,
      updated_at: now,
    });
    await db.entries.put(part);
    return true;
  });
}
