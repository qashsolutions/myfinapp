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
 * The largest bill counted (a technical guard; signed off by the owner November 9, 2026): $100
 * million, so the sums of every bill a group could hold stay inside the engine's exact integers
 * and one absurd bill can never stop everyone's balances.
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

// ---- monthly pages (chunk S.5, November 9, 2026) ----
//
// On the server a member's ledger is a small head (`ledger`: the organizer's group settings) and
// one page a month (`ledger:YYYY-MM`: what they recorded that month), each a blob of its own, so
// no ledger ever fills up. A page is written compactly: member ids once in `p`, then indexes.
// Reading puts the pages back together as one `LedgerBlob`; writing puts each change back on the
// page it came from, and anything new on the newest page.

export const PAGE_FORMAT = 2;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export interface LedgerPage {
  bills: SplitBill[];
  edits: Record<string, SplitBill | null>;
  approved: Record<string, SplitBill>;
  settlements: SplitSettlement[];
}

export interface HeadBlob {
  v: typeof PAGE_FORMAT;
  group: GroupMeta | null;
}

const METHOD_CODES = ["equal", "exact", "percent", "shares"] as const;
const REPEAT_CODES = ["weekly", "monthly", "yearly"] as const;
const APP_CODES = ["venmo", "cashapp", "paypal", "other"] as const;

/** [id, date, what, amount, paid by, people, method, values, leftover to, parts, repeat,
 * repeat until, updated at]; people are indexes into the page's `p`, and values and parts line up
 * with the bill's people (null where a person has none). */
type PackedBill = [
  string,
  string,
  string,
  number,
  number,
  number[],
  number,
  Array<number | null> | null,
  number,
  Array<number | null>,
  number | null,
  string | null,
  string,
];
/** [id, from, to, cents, date, via, confirms, at] */
type PackedSettlement = [string, number, number, number, string, number, string | null, string];

export interface PageBlob {
  v: typeof PAGE_FORMAT;
  p: string[];
  b: PackedBill[];
  e: Array<[string, PackedBill | null]>;
  a: Array<[string, PackedBill]>;
  s: PackedSettlement[];
}

export function emptyPage(): LedgerPage {
  return { bills: [], edits: {}, approved: {}, settlements: [] };
}

export const isMonth = (m: string): boolean => MONTH.test(m);

/** The page a member's blob kind names, or null for the head and anything else. */
export function pageMonth(kind: string): string | null {
  const m = kind.startsWith("ledger:") ? kind.slice(7) : null;
  return m && isMonth(m) ? m : null;
}

export function encodePage(page: LedgerPage): PageBlob {
  const p: string[] = [];
  const at = new Map<string, number>();
  const ix = (id: string) => {
    let i = at.get(id);
    if (i === undefined) {
      i = p.length;
      p.push(id);
      at.set(id, i);
    }
    return i;
  };
  const bill = (b: SplitBill): PackedBill => {
    const parts = new Map(b.parts.map((x) => [x.person, x.cents]));
    return [
      b.id,
      b.date,
      b.what,
      b.amount_cents,
      ix(b.paid_by),
      b.people.map(ix),
      METHOD_CODES.indexOf(b.method as (typeof METHOD_CODES)[number]),
      b.values ? b.people.map((x) => b.values?.[x] ?? null) : null,
      ix(b.leftover_to),
      b.people.map((x) => parts.get(x) ?? null),
      b.repeat ? REPEAT_CODES.indexOf(b.repeat) : null,
      b.repeat_until,
      b.updated_at,
    ];
  };
  return {
    v: PAGE_FORMAT,
    p,
    b: page.bills.map(bill),
    e: Object.entries(page.edits).map(([id, b]) => [id, b ? bill(b) : null]),
    a: Object.entries(page.approved).map(([id, b]) => [id, bill(b)]),
    s: page.settlements.map((x) => [
      x.id,
      ix(x.from),
      ix(x.to),
      x.cents,
      x.date,
      APP_CODES.indexOf(x.via),
      x.confirms,
      x.at,
    ]),
  };
}

/** A page read back, or null when it isn't one. Anything malformed comes out as a bill or a
 * settlement that `isValidBill` / `isValidSettlement` then leaves out, never as a throw. */
export function decodePage(value: unknown, author: string): LedgerPage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PageBlob>;
  if (v.v !== PAGE_FORMAT || !Array.isArray(v.p)) return null;
  const p = v.p;
  const who = (i: unknown): string =>
    typeof i === "number" &&
    Number.isInteger(i) &&
    i >= 0 &&
    i < p.length &&
    typeof p[i] === "string"
      ? (p[i] as string)
      : "";
  const code = <T>(list: readonly T[], i: unknown): T | undefined =>
    typeof i === "number" && Number.isInteger(i) ? list[i] : undefined;
  const bill = (x: unknown): SplitBill | null => {
    if (!Array.isArray(x) || x.length !== 13) return null;
    const [
      id,
      date,
      what,
      amount,
      paidBy,
      people,
      method,
      values,
      leftover,
      parts,
      repeat,
      until,
      at,
    ] = x as unknown[];
    if (!Array.isArray(people) || !Array.isArray(parts)) return null;
    const ids = people.map(who);
    const vals = Array.isArray(values) ? values : null;
    return {
      id: id as string,
      date: date as string,
      what: what as string,
      amount_cents: amount as number,
      paid_by: who(paidBy),
      people: ids,
      method: code(METHOD_CODES, method) as SplitMethod,
      values: vals
        ? Object.fromEntries(
            ids.flatMap((person, i) => (vals[i] == null ? [] : [[person, vals[i] as number]])),
          )
        : null,
      leftover_to: who(leftover),
      parts: ids.flatMap((person, i) =>
        parts[i] == null ? [] : [{ person, cents: parts[i] as number }],
      ),
      repeat: repeat === null ? null : ((code(REPEAT_CODES, repeat) ?? "?") as SplitRepeat),
      repeat_until: (until ?? null) as string | null,
      added_by: author,
      updated_at: typeof at === "string" ? at : "",
    };
  };
  const pairs = (list: unknown): Array<[string, unknown]> =>
    Array.isArray(list)
      ? list.filter(
          (e): e is [string, unknown] =>
            Array.isArray(e) && e.length === 2 && typeof e[0] === "string",
        )
      : [];
  const page = emptyPage();
  for (const x of Array.isArray(v.b) ? v.b : []) {
    const b = bill(x);
    if (b) page.bills.push(b);
  }
  for (const [id, x] of pairs(v.e)) {
    if (x === null) page.edits[id] = null;
    else {
      const b = bill(x);
      if (b) page.edits[id] = b;
    }
  }
  for (const [id, x] of pairs(v.a)) {
    const b = bill(x);
    if (b) page.approved[id] = b;
  }
  for (const x of Array.isArray(v.s) ? v.s : []) {
    if (!Array.isArray(x) || x.length !== 8) continue;
    const [id, from, to, cents, date, via, confirms, at] = x as unknown[];
    page.settlements.push({
      id: id as string,
      from: who(from),
      to: who(to),
      cents: cents as number,
      date: date as string,
      via: (code(APP_CODES, via) ?? "?") as PayApp,
      confirms: (confirms ?? null) as string | null,
      at: typeof at === "string" ? at : "",
    });
  }
  return page;
}

export function parseHead(value: unknown): HeadBlob | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<HeadBlob>;
  if (v.v !== PAGE_FORMAT) return null;
  return { v: PAGE_FORMAT, group: v.group ?? null };
}

const byMonth = (pages: Map<string, LedgerPage>) =>
  [...pages.entries()].sort(([a], [b]) => compareText(a, b));

/** A member's pages as one ledger: a later page's copy of a bill, a settlement, an edit or an
 * approval wins over an earlier one's. */
export function combinePages(head: HeadBlob | null, pages: Map<string, LedgerPage>): LedgerBlob {
  const bills = new Map<string, SplitBill>();
  const settlements = new Map<string, SplitSettlement>();
  const out = emptyLedger();
  for (const [, page] of byMonth(pages)) {
    for (const b of page.bills) bills.set(b.id, b);
    for (const s of page.settlements) settlements.set(s.id, s);
    Object.assign(out.edits, page.edits);
    Object.assign(out.approved as Record<string, SplitBill>, page.approved);
  }
  out.bills = [...bills.values()];
  out.settlements = [...settlements.values()];
  out.group = head?.group ?? null;
  return out;
}

/** The same value whatever order its keys were written in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort(compareText)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * Where a changed ledger goes: every bill and settlement stays on the page it was recorded on
 * (removed ones leave it), anything new goes on `month`, a changed edit or approval is written
 * on `month` (the later page wins), and a withdrawn one leaves every page. Returns every page,
 * changed or not; the caller writes the ones whose content changed.
 */
export function placeOnPages(
  before: Map<string, LedgerPage>,
  next: LedgerBlob,
  month: string,
): Map<string, LedgerPage> {
  const billAt = new Map<string, string>();
  const settledAt = new Map<string, string>();
  for (const [m, page] of byMonth(before)) {
    for (const b of page.bills) billAt.set(b.id, m);
    for (const s of page.settlements) settledAt.set(s.id, m);
  }
  const was = combinePages(null, before);
  const out = new Map<string, LedgerPage>();
  for (const [m, page] of before)
    out.set(m, { ...emptyPage(), edits: { ...page.edits }, approved: { ...page.approved } });
  if (!out.has(month)) out.set(month, emptyPage());
  const pageOf = (m: string) => out.get(m) ?? (out.set(m, emptyPage()).get(m) as LedgerPage);

  const lastById = <T extends { id: string }>(list: T[]) => [
    ...new Map(list.map((x) => [x.id, x])).values(),
  ];
  for (const b of lastById(next.bills)) pageOf(billAt.get(b.id) ?? month).bills.push(b);
  for (const s of lastById(next.settlements))
    pageOf(settledAt.get(s.id) ?? month).settlements.push(s);

  const place = <T>(
    field: "edits" | "approved",
    old: Record<string, T>,
    now: Record<string, T>,
  ) => {
    for (const [id, value] of Object.entries(now)) {
      if (Object.hasOwn(old, id) && canonical(old[id]) === canonical(value)) continue;
      (pageOf(month)[field] as Record<string, T>)[id] = value;
    }
    for (const id of Object.keys(old)) {
      if (Object.hasOwn(now, id)) continue;
      for (const page of out.values()) delete (page[field] as Record<string, T>)[id];
    }
  };
  place("edits", was.edits, recordOf<SplitBill | null>(next.edits));
  place("approved", was.approved ?? {}, recordOf<SplitBill>(next.approved));
  return out;
}
