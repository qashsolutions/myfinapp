/**
 * Spotted (spec "Settling up", November 10, 2026): on a device with linked accounts, a bank row
 * that looks like a friend settling up is suggested against a payment the group says is due,
 * never applied. "Spotted · $76 came in by Venmo on Nov 7 · Mark settled / Not this".
 *
 * A row matches a payment when it is linked and posted, in the payment's direction for me (in
 * when they pay me, out when I pay them), for exactly its amount, within SPOTTED_DAYS of today,
 * says a payment app, and isn't already part of a split. Each row and each payment is offered
 * once. Pure: the caller passes today and what was already turned down.
 */

import type { Entry } from "../../data/db.ts";
import { compareText } from "../../lib/order.ts";
import type { PayApp } from "./ledger.ts";

/** How far back a bank row may be (proposed with Spotted, November 11, 2026). */
export const SPOTTED_DAYS = 14;

const APPS: Array<[RegExp, PayApp]> = [
  [/\bVENMO\b/i, "venmo"],
  [/\bCASH\s?APP\b|\bSQC\b/i, "cashapp"],
  [/\bPAYPAL\b/i, "paypal"],
  [/\bZELLE\b/i, "other"],
];

export function payAppOf(text: string): { app: PayApp; label: string } | null {
  for (const [re, app] of APPS) {
    const m = text.match(re);
    if (m) return { app, label: app === "other" ? "Zelle" : m[0].replace(/\s+/g, " ") };
  }
  return null;
}

export interface Spot {
  entry: Entry;
  payment: { from: string; to: string; cents: number };
  app: PayApp;
  appLabel: string;
  direction: "in" | "out";
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The first word of a person's name as a bank row would show it ("Sam" of "Sam L."). */
function firstName(name: string): string | null {
  const w = name.trim().split(/\s+/)[0] ?? "";
  return w.length >= 2 && w !== "You" && w !== "Former" ? w : null;
}

const mentions = (text: string, word: string) =>
  new RegExp(`(^|[^A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(
    text,
  );

export function spotted(
  payments: Array<{ from: string; to: string; cents: number }>,
  me: string,
  entries: Entry[],
  dismissed: Set<string>,
  today: string,
  /** Member names: a row that names someone matches that person first, and never anyone else. */
  nameOf: (memberId: string) => string = () => "",
  /** Everyone in the group, so a row naming someone who owes nothing is still theirs. */
  members: string[] = [],
): Spot[] {
  const candidates = entries
    .filter(
      (e) =>
        e.provider_txn_id &&
        !e.pending &&
        !e.is_transfer &&
        !e.paid_back &&
        !e.split_settle &&
        !e.split_bill &&
        !dismissed.has(e.id) &&
        compareText(e.date, today) <= 0 &&
        daysBetween(e.date, today) <= SPOTTED_DAYS,
    )
    .sort((a, b) => compareText(b.date, a.date) || compareText(a.id, b.id));
  const textOf = (e: Entry) => `${e.raw_description ?? ""} ${e.merchant}`;
  const other = (p: { from: string; to: string }) => (p.to === me ? p.from : p.to);
  const everyone = [...new Set([...members, ...payments.flatMap((p) => [p.from, p.to])])].filter(
    (id) => id !== me,
  );
  const named = (e: Entry) =>
    everyone.filter((id) => {
      const w = firstName(nameOf(id));
      return w !== null && mentions(textOf(e), w);
    });
  const used = new Set<string>();
  const taken = new Set<number>();
  const out: Array<Spot & { order: number }> = [];
  // First pass: rows that name the person; second: rows that name nobody in the group.
  for (const pass of ["named", "plain"] as const) {
    payments.forEach((p, i) => {
      if (taken.has(i)) return;
      const direction = p.to === me ? "in" : p.from === me ? "out" : null;
      if (!direction) return;
      for (const e of candidates) {
        if (used.has(e.id) || e.direction !== direction || e.amount_cents !== p.cents) continue;
        const who = named(e);
        if (pass === "named" ? !who.includes(other(p)) : who.length > 0) continue;
        const app = payAppOf(textOf(e));
        if (!app) continue;
        used.add(e.id);
        taken.add(i);
        out.push({ entry: e, payment: p, app: app.app, appLabel: app.label, direction, order: i });
        return;
      }
    });
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _o, ...spot }) => spot);
}
