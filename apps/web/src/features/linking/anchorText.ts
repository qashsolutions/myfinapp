/**
 * Where a balance came from, in one place (invariant 64): a statement's date, the bank through
 * a link (its name and when it last synced), or the person. A linked balance is never "you
 * entered" and a linked account is never "Never imported".
 */

import type { Account, BalanceAnchor } from "../../data/db.ts";
import { formatDay, formatSince } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";

/** The bank's name for a linked account, else a plain stand-in. */
export function bankName(account: Pick<Account, "institution"> | null | undefined): string {
  return account?.institution?.trim() || "your bank";
}

/** "from Oct 3 statement", "from Chase · synced 5 min ago", or "you entered". */
export function balanceSourceText(
  anchor: Pick<BalanceAnchor, "source" | "as_of" | "created_at">,
  account: Pick<Account, "institution"> | null | undefined,
  now: Date = new Date(),
): string {
  if (anchor.source === "statement") return `from ${formatDay(anchor.as_of, now)} statement`;
  if (anchor.source === "linked")
    return `from ${bankName(account)} · synced ${formatSince(anchor.created_at, now)}`;
  return `you entered ${formatDay(anchor.as_of, now)}`;
}

/** "Linked · synced 5 min ago" for a linked account (its newest linked balance), else null. */
export function linkedStatusText(
  account: Pick<Account, "linked" | "institution">,
  anchors: readonly Pick<BalanceAnchor, "source" | "created_at">[],
  now: Date = new Date(),
): string | null {
  if (!account.linked) return null;
  const last = anchors
    .filter((a) => a.source === "linked")
    .map((a) => a.created_at)
    .sort(compareText)
    .at(-1);
  return last ? `Linked · synced ${formatSince(last, now)}` : "Linked · not synced yet";
}
