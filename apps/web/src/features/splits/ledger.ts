/**
 * Split bills: what each member's encrypted ledger holds, and the one way every device merges
 * them (invariant 77; spec "Split bills"). The server can't read a bill, so the rules live here,
 * the same on every device:
 *
 * - a bill counts only when the server issued its id and approved it (a guest's bill waits for
 *   the organizer's OK); a repeating bill's later copies take the id `<bill id>:<date>`;
 * - edits, deletes and the group's settings count only from the organizer's own ledger;
 * - a settlement counts only when the person paid (`to`) or the organizer recorded it; one the
 *   payer recorded is a claim until the person paid confirms it;
 * - every ledger is read as its author's: a blob's author is the member it is stored under, and
 *   the blob is encrypted with that member in its associated data, so it can't be moved.
 *
 * Pure: no I/O, no clock (the caller passes the repeat dates it computed through the engine).
 */

import type { SplitMethod, SplitPart, SplitRepeat } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";

export const LEDGER_VERSION = 1;
export const MAX_WHAT = 60;

export interface SplitBill {
  /** The server-issued id (`POST /api/splits/{id}/bills`). */
  id: string;
  /** YYYY-MM-DD, the day it was paid (a repeating bill's first day). */
  date: string;
  what: string;
  amount_cents: number;
  /** Member ids. */
  paid_by: string;
  people: string[];
  method: SplitMethod;
  values: Record<string, number> | null;
  leftover_to: string;
  /** From `splits.share` when saved: whole cents, adding up to `amount_cents`. */
  parts: SplitPart[];
  repeat: SplitRepeat | null;
  /** The organizer stopped a repeating bill: no copies after this day. */
  repeat_until: string | null;
  added_by: string;
  updated_at: string;
}

export type PayApp = "venmo" | "cashapp" | "paypal" | "other";

export interface SplitSettlement {
  id: string;
  from: string;
  to: string;
  cents: number;
  date: string;
  via: PayApp;
  /** A receiver's (or organizer's) record that confirms the payer's claim with this id. */
  confirms: string | null;
  at: string;
}

export interface GroupMeta {
  name: string;
  kind: string;
  usual_method: SplitMethod;
  /** Who absorbs a leftover cent: whoever paid, or a member id. */
  leftover: "payer" | string;
  updated_at: string;
}

export interface LedgerBlob {
  v: typeof LEDGER_VERSION;
  bills: SplitBill[];
  /** Organizer only: a bill id → its corrected copy, or null when deleted. */
  edits: Record<string, SplitBill | null>;
  /** Organizer only: someone else's bill as the organizer approved it. That copy counts, so
   * its author can't change an approved bill by rewriting their own ledger (November 9, 2026). */
  approved?: Record<string, SplitBill>;
  settlements: SplitSettlement[];
  /** Organizer only. */
  group: GroupMeta | null;
}

export type HandleApp = Exclude<PayApp, "other">;

export interface ProfileBlob {
  v: typeof LEDGER_VERSION;
  name: string;
  handles: Partial<Record<HandleApp, string>>;
  /** When each handle last changed: "Changed recently · check with <name>" for 3 days. */
  changed: Partial<Record<HandleApp, string>>;
  saved_at: string;
}

export function emptyLedger(): LedgerBlob {
  return { v: LEDGER_VERSION, bills: [], edits: {}, approved: {}, settlements: [], group: null };
}

/**
 * The largest bill counted (a technical guard, November 9, 2026, proposed): $100 million, so the
 * sums of every bill a group could hold stay inside the engine's exact integers and one absurd
 * bill can never stop everyone's balances.
 */
export const MAX_BILL_CENTS = 10_000_000_000;

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const METHODS_SET = new Set(["equal", "exact", "percent", "shares"]);
const REPEATS_SET = new Set(["weekly", "monthly", "yearly"]);
const APPS = new Set(["venmo", "cashapp", "paypal", "other"]);
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;
const isCents = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_BILL_CENTS;

/** A bill every device can count: whole cents that add up, each person once, known fields. */
export function isValidBill(b: unknown): b is SplitBill {
  if (!b || typeof b !== "object") return false;
  const x = b as Partial<SplitBill>;
  if (!isText(x.id) || !isText(x.added_by) || !isText(x.paid_by) || !isText(x.leftover_to))
    return false;
  if (typeof x.date !== "string" || !DATE.test(x.date) || typeof x.what !== "string") return false;
  if (!isCents(x.amount_cents, 1) || !METHODS_SET.has(x.method as string)) return false;
  if (x.repeat !== null && !REPEATS_SET.has(x.repeat as string)) return false;
  if (x.repeat_until !== null && !(typeof x.repeat_until === "string" && DATE.test(x.repeat_until)))
    return false;
  if (!Array.isArray(x.people) || x.people.length === 0 || !x.people.every(isText)) return false;
  if (new Set(x.people).size !== x.people.length || !Array.isArray(x.parts)) return false;
  const seen = new Set<string>();
  let sum = 0;
  for (const p of x.parts) {
    if (!p || !isText(p.person) || !isCents(p.cents, 0)) return false;
    if (seen.has(p.person) || !x.people.includes(p.person)) return false;
    seen.add(p.person);
    sum += p.cents;
  }
  return sum === x.amount_cents;
}

export function isValidSettlement(s: unknown): s is SplitSettlement {
  if (!s || typeof s !== "object") return false;
  const x = s as Partial<SplitSettlement>;
  return (
    isText(x.id) &&
    isText(x.from) &&
    isText(x.to) &&
    x.from !== x.to &&
    isCents(x.cents, 1) &&
    typeof x.date === "string" &&
    DATE.test(x.date) &&
    APPS.has(x.via as string) &&
    (x.confirms === null || isText(x.confirms))
  );
}

function billsOf(ledger: LedgerBlob | undefined): SplitBill[] {
  return Array.isArray(ledger?.bills) ? ledger.bills.filter(isValidBill) : [];
}

function recordOf<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

export interface MergeInput {
  organizer: string | null;
  ledgers: Map<string, LedgerBlob>;
  approved: Set<string>;
  pending: Set<string>;
  disputed: Set<string>;
  /** For a repeating bill: its due dates through today (from `splits.repeat_dates`). */
  repeatDates: (bill: SplitBill) => string[];
}

export interface ShownBill extends SplitBill {
  /** The server id this bill stands on (a repeat's copies share their first bill's). */
  base_id: string;
  status: "approved" | "pending";
  disputed: boolean;
  edited: boolean;
}

export interface Claim extends SplitSettlement {
  /** Recorded by the payer and not yet confirmed by the person paid. */
  claimed_by: string;
}

export interface Merged {
  group: GroupMeta | null;
  bills: ShownBill[];
  settlements: SplitSettlement[];
  claims: Claim[];
}

function byDateThenId(a: { date: string; id: string }, b: { date: string; id: string }): number {
  return compareText(b.date, a.date) || compareText(a.id, b.id);
}

export function merge(input: MergeInput): Merged {
  const { organizer, ledgers } = input;
  const own = organizer ? ledgers.get(organizer) : undefined;
  const edits = recordOf<SplitBill | null>(own?.edits);
  const pins = recordOf<SplitBill>(own?.approved);
  const bills: ShownBill[] = [];
  const seen = new Set<string>();
  for (const [author, ledger] of ledgers) {
    for (const raw of billsOf(ledger)) {
      // A bill is its author's: a copy in someone else's ledger never counts.
      if (raw.added_by !== author || seen.has(raw.id)) continue;
      const approved = input.approved.has(raw.id);
      if (!approved && !input.pending.has(raw.id)) continue;
      seen.add(raw.id);
      const edit = Object.hasOwn(edits, raw.id) ? edits[raw.id] : undefined;
      if (edit === null) continue; // deleted by the organizer
      // Someone else's approved bill counts as the organizer approved it (their pinned copy).
      const pin =
        approved && author !== organizer && isValidBill(pins[raw.id]) ? pins[raw.id] : undefined;
      const base: SplitBill = pin ? { ...pin, id: raw.id, added_by: raw.added_by } : raw;
      const bill: SplitBill =
        edit && isValidBill(edit) ? { ...edit, id: raw.id, added_by: raw.added_by } : base;
      const shown: ShownBill = {
        ...bill,
        base_id: raw.id,
        status: approved ? "approved" : "pending",
        disputed: input.disputed.has(raw.id),
        edited: Boolean(edit && isValidBill(edit)),
      };
      bills.push(shown);
      if (approved && bill.repeat) {
        for (const date of input.repeatDates(bill)) {
          if (date === bill.date) continue;
          if (bill.repeat_until && compareText(date, bill.repeat_until) > 0) break;
          bills.push({ ...shown, id: `${raw.id}:${date}`, date });
        }
      }
    }
  }
  bills.sort(byDateThenId);

  const settlements: SplitSettlement[] = [];
  const offered: Claim[] = [];
  const confirmed = new Set<string>();
  for (const [author, ledger] of ledgers) {
    for (const s of Array.isArray(ledger?.settlements) ? ledger.settlements : []) {
      if (!isValidSettlement(s)) continue;
      if (author === s.to || author === organizer) {
        settlements.push(s);
        if (s.confirms) confirmed.add(s.confirms);
      } else if (author === s.from) {
        offered.push({ ...s, claimed_by: author });
      }
    }
  }
  settlements.sort(byDateThenId);
  const claims = offered.filter((c) => !confirmed.has(c.id)).sort(byDateThenId);
  const group = own?.group;
  return {
    group: group && typeof group === "object" && typeof group.name === "string" ? group : null,
    bills,
    settlements,
    claims,
  };
}

/** The facts `splits.balances` takes: approved bills only; a pending one moves nobody. */
export function balanceFacts(merged: Merged): {
  bills: Array<{
    id: string;
    amount_cents: number;
    paid_by: string;
    parts: SplitPart[];
    disputed: boolean;
  }>;
  settlements: Array<{ from: string; to: string; cents: number }>;
} {
  return {
    bills: merged.bills
      .filter((b) => b.status === "approved")
      .map((b) => ({
        id: b.id,
        amount_cents: b.amount_cents,
        paid_by: b.paid_by,
        parts: b.parts,
        disputed: b.disputed,
      })),
    settlements: merged.settlements.map((s) => ({ from: s.from, to: s.to, cents: s.cents })),
  };
}

/** Every member id a bill or a settlement names, the live members first (a former member's
 * bills stay with the group, so balances never change when someone leaves). */
export function peopleIn(live: string[], merged: Merged): string[] {
  const out = [...live];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const b of merged.bills) {
    add(b.paid_by);
    for (const p of b.parts) add(p.person);
  }
  for (const s of merged.settlements) {
    add(s.from);
    add(s.to);
  }
  return out;
}

/** A ledger read back from JSON, or null when it isn't one (an unknown version is skipped). */
export function parseLedger(value: unknown): LedgerBlob | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<LedgerBlob>;
  if (v.v !== LEDGER_VERSION || !Array.isArray(v.bills) || !Array.isArray(v.settlements))
    return null;
  return {
    v: LEDGER_VERSION,
    bills: v.bills,
    edits: recordOf(v.edits),
    approved: recordOf(v.approved),
    settlements: v.settlements,
    group: v.group ?? null,
  };
}

export function parseProfile(value: unknown): ProfileBlob | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ProfileBlob>;
  if (v.v !== LEDGER_VERSION || typeof v.name !== "string") return null;
  return {
    v: LEDGER_VERSION,
    name: v.name,
    handles: v.handles && typeof v.handles === "object" ? v.handles : {},
    changed: v.changed && typeof v.changed === "object" ? v.changed : {},
    saved_at: typeof v.saved_at === "string" ? v.saved_at : "",
  };
}
