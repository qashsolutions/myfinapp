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
import { formatCents, formatDay } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";

export const LEDGER_VERSION = 1;
export const MAX_WHAT = 60;
/** A note on a payment or a dispute (S.7; 120 characters, signed off by the owner November 10, 2026). */
export const NOTE_MAX = 120;
/** How long whoever recorded a payment may undo it (S.7; 7 days, signed off by the owner November 10, 2026). */
export const UNDO_DAYS = 7;

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
  /** S.7: an optional note, and when its recorder undid it (it then moves nobody). */
  note?: string | null;
  undone_at?: string | null;
}

/** A payment as merged: who recorded it, for Undo. */
export interface CountedSettlement extends SplitSettlement {
  by: string;
}

export interface GroupMeta {
  name: string;
  kind: string;
  usual_method: SplitMethod;
  /** For a usual split by percent (bps) or shares: each member's value (S.6). A guest's bill
   * uses them when everyone in it has one. */
  usual_values?: Record<string, number> | null;
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
  /** S.7: my note on a bill I disputed, by bill id. */
  dispute_notes?: Record<string, string>;
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
  return {
    v: LEDGER_VERSION,
    bills: [],
    edits: {},
    approved: {},
    settlements: [],
    group: null,
    dispute_notes: {},
  };
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
    (x.confirms === null || isText(x.confirms)) &&
    (x.note == null || (typeof x.note === "string" && x.note.length <= NOTE_MAX)) &&
    (x.undone_at == null || typeof x.undone_at === "string")
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
  /** For the bill's history (S.6): when its author added it, when the organizer approved
   * someone else's, and the bill as it stood before the organizer's last change. */
  added_at: string;
  approved_at: string | null;
  before_edit: SplitBill | null;
}

/** A group's name on screen: a split with one person reads "You and Sam" (S.9). */
export function groupTitle(meta: GroupMeta | null | undefined): string | null {
  if (!meta) return null;
  return meta.kind === "one" ? `You and ${meta.name}` : meta.name;
}

/** A shown bill back to the stored shape, without what merge adds for the screen. */
export function asBill(shown: ShownBill): SplitBill {
  return {
    id: shown.base_id,
    date: shown.date,
    what: shown.what,
    amount_cents: shown.amount_cents,
    paid_by: shown.paid_by,
    people: shown.people,
    method: shown.method,
    values: shown.values,
    leftover_to: shown.leftover_to,
    parts: shown.parts,
    repeat: shown.repeat,
    repeat_until: shown.repeat_until,
    added_by: shown.added_by,
    updated_at: shown.updated_at,
  };
}

export interface Claim extends SplitSettlement {
  /** Recorded by the payer and not yet confirmed by the person paid. */
  claimed_by: string;
}

export interface Merged {
  group: GroupMeta | null;
  bills: ShownBill[];
  settlements: CountedSettlement[];
  claims: Claim[];
  /** S.7: payments their recorder undid; they move nobody. */
  undone: CountedSettlement[];
  /** S.7: each disputer's note on a bill, from their own ledger. */
  dispute_notes: Array<{ bill_id: string; member: string; note: string }>;
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
      const edited = Boolean(edit && isValidBill(edit));
      const shown: ShownBill = {
        ...bill,
        base_id: raw.id,
        status: approved ? "approved" : "pending",
        disputed: input.disputed.has(raw.id),
        edited,
        added_at: raw.updated_at,
        approved_at: pin ? pin.updated_at : null,
        before_edit: edited ? base : null,
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

  const settlements: CountedSettlement[] = [];
  const undone: CountedSettlement[] = [];
  const offered: Claim[] = [];
  const confirmed = new Set<string>();
  for (const [author, ledger] of ledgers) {
    for (const s of Array.isArray(ledger?.settlements) ? ledger.settlements : []) {
      if (!isValidSettlement(s)) continue;
      if (s.undone_at) {
        if (author === s.to || author === organizer || author === s.from)
          undone.push({ ...s, by: author });
        continue;
      }
      if (author === s.to || author === organizer) {
        settlements.push({ ...s, by: author });
        if (s.confirms) confirmed.add(s.confirms);
      } else if (author === s.from) {
        offered.push({ ...s, claimed_by: author });
      }
    }
  }
  const dispute_notes: Merged["dispute_notes"] = [];
  for (const [author, ledger] of ledgers)
    for (const [bill_id, note] of Object.entries(recordOf<string>(ledger?.dispute_notes)))
      if (typeof note === "string" && note.length > 0 && note.length <= NOTE_MAX)
        dispute_notes.push({ bill_id, member: author, note });
  settlements.sort(byDateThenId);
  // A claim that also counts (a new organizer copied it on taking over) is no longer a claim.
  const counted = new Set(settlements.map((s) => s.id));
  const claims = offered
    .filter((c) => !confirmed.has(c.id) && !counted.has(c.id))
    .sort(byDateThenId);
  const group = own?.group;
  return {
    group: group && typeof group === "object" && typeof group.name === "string" ? group : null,
    bills,
    settlements,
    claims,
    undone: undone.sort(byDateThenId),
    dispute_notes,
  };
}

/**
 * Run this group (S.6): a new organizer's ledger takes the previous organizer's settings,
 * corrections, deletions and approvals, and the payments that counted only because they
 * recorded them, so every device shows the same group after the takeover as before. What the
 * new organizer had already decided wins.
 */
export function takeOverLedger(mine: LedgerBlob, theirs: LedgerBlob, theirId: string): LedgerBlob {
  const have = new Set(mine.settlements.map((s) => s.id));
  const carried = (Array.isArray(theirs.settlements) ? theirs.settlements : []).filter(
    (s) => isValidSettlement(s) && s.to !== theirId && !have.has(s.id),
  );
  return {
    ...mine,
    group: mine.group ?? theirs.group ?? null,
    edits: { ...recordOf<SplitBill | null>(theirs.edits), ...mine.edits },
    approved: { ...recordOf<SplitBill>(theirs.approved), ...(mine.approved ?? {}) },
    settlements: [...mine.settlements, ...carried],
  };
}

/** A guest's bill (S.6): the group's usual split when it covers everyone, else equal. */
export function guestSplit(
  meta: GroupMeta | null,
  people: string[],
): { method: SplitMethod; values: Record<string, number> | null } {
  const equal = { method: "equal" as SplitMethod, values: null };
  if (!meta || meta.usual_method === "equal" || meta.usual_method === "exact") return equal;
  const v = meta.usual_values ?? {};
  const values: Record<string, number> = {};
  for (const p of people) {
    const n = v[p];
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return equal;
    values[p] = n;
  }
  if (meta.usual_method === "percent") {
    const sum = people.reduce((t, p) => t + (values[p] ?? 0), 0);
    if (sum !== 10000) return equal;
  }
  return { method: meta.usual_method, values };
}

const REPEAT_WORDS: Record<string, string> = {
  weekly: "weekly",
  monthly: "monthly",
  yearly: "yearly",
};
const METHOD_WORDS: Record<string, string> = {
  equal: "equally",
  exact: "exact amounts",
  percent: "percent",
  shares: "shares",
};

/** What changed between two copies of a bill, in the words the bill sheet shows. */
function changes(a: SplitBill, b: SplitBill, name: (id: string) => string): string[] {
  const out: string[] = [];
  if (a.amount_cents !== b.amount_cents)
    out.push(`amount ${formatCents(a.amount_cents)} → ${formatCents(b.amount_cents)}`);
  if (a.what !== b.what) out.push(`what ${a.what} → ${b.what}`);
  if (a.date !== b.date) out.push(`date ${formatDay(a.date)} → ${formatDay(b.date)}`);
  if (a.paid_by !== b.paid_by) out.push(`paid by ${name(a.paid_by)} → ${name(b.paid_by)}`);
  const who = (x: SplitBill) => x.people.map(name).join(", ");
  if (who(a) !== who(b)) out.push(`who's in ${who(a)} → ${who(b)}`);
  const parts = (x: SplitBill) => canonical(x.parts);
  if (a.method !== b.method)
    out.push(`split ${METHOD_WORDS[a.method] ?? a.method} → ${METHOD_WORDS[b.method] ?? b.method}`);
  else if (out.length === 0 && parts(a) !== parts(b)) out.push("each person's part");
  const rep = (x: SplitBill) => (x.repeat ? (REPEAT_WORDS[x.repeat] ?? x.repeat) : "once");
  if (rep(a) !== rep(b)) out.push(`repeats ${rep(a)} → ${rep(b)}`);
  return out;
}

/** A bill's history (S.6): added, approved, the organizer's last change, a stopped repeat. */
export function billHistory(
  bill: ShownBill,
  organizer: string | null,
  name: (id: string) => string,
): Array<{ at: string; text: string }> {
  const out = [{ at: bill.added_at, text: `Added by ${name(bill.added_by)}` }];
  const by = organizer ? name(organizer) : "the organizer";
  if (bill.approved_at) out.push({ at: bill.approved_at, text: `Approved by ${by}` });
  if (bill.before_edit) {
    const what = changes(bill.before_edit, bill, name).filter((c) => !c.startsWith("repeats"));
    if (what.length)
      out.push({ at: bill.updated_at, text: `Changed by ${by}: ${what.join(" · ")}` });
    if (bill.repeat_until && !bill.before_edit.repeat_until)
      out.push({
        at: bill.updated_at,
        text: `Stopped repeating after ${formatDay(bill.repeat_until)}`,
      });
  }
  return out;
}

/** Whoever recorded a payment may undo it within UNDO_DAYS of recording it (S.7). */
export function canUndo(s: SplitSettlement, by: string, me: string, now: Date): boolean {
  if (by !== me || s.undone_at) return false;
  const at = Date.parse(s.at);
  return Number.isFinite(at) && now.getTime() - at <= UNDO_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The group's History (S.7): bills added, approved and changed, payments recorded and undone,
 * disputes with their notes, newest first. Built from the ledgers on the device. A dispute has
 * no time on the device, so it is listed last.
 */
export function groupHistory(
  merged: Merged,
  organizer: string | null,
  name: (id: string) => string,
  disputes: Array<{ bill_id: string; member_id: string | null }>,
): Array<{ at: string; text: string; settlement?: CountedSettlement }> {
  const out: Array<{ at: string; text: string; settlement?: CountedSettlement }> = [];
  const by = organizer ? name(organizer) : "the organizer";
  const seen = new Set<string>();
  for (const b of merged.bills) {
    if (seen.has(b.base_id)) continue; // a repeat's copies are one bill
    seen.add(b.base_id);
    const what = b.what || "a bill";
    const first = b.before_edit ?? b;
    out.push({
      at: b.added_at,
      text: `Added ${what}, ${formatCents(first.amount_cents)}, by ${name(b.added_by)}`,
    });
    if (b.approved_at) out.push({ at: b.approved_at, text: `${by} approved ${what}` });
    if (b.before_edit) {
      const what2 = changes(b.before_edit, b, name);
      if (what2.length)
        out.push({ at: b.updated_at, text: `${by} changed ${what}: ${what2.join(" · ")}` });
    }
  }
  const whom = (id: string) => (name(id) === "You" ? "you" : name(id));
  const paid = (s: SplitSettlement) =>
    `${name(s.from)} paid ${whom(s.to)} ${formatCents(s.cents)}${s.note ? ` · ${s.note}` : ""}`;
  for (const s of merged.settlements) out.push({ at: s.at, text: paid(s), settlement: s });
  for (const s of merged.undone) out.push({ at: s.undone_at ?? s.at, text: `${paid(s)} · undone` });
  for (const c of merged.claims)
    out.push({ at: c.at, text: `${paid(c)} · waiting for ${whom(c.to)} to confirm` });
  out.sort((a, b) => compareText(b.at, a.at));
  const billName = (id: string) => merged.bills.find((b) => b.base_id === id)?.what || "a bill";
  for (const d of disputes) {
    const who = d.member_id ? name(d.member_id) : "A former member";
    const note = merged.dispute_notes.find(
      (n) => n.bill_id === d.bill_id && n.member === d.member_id,
    );
    out.push({
      at: "",
      text: `${who} disputed ${billName(d.bill_id)}${note ? `: ${note.note}` : ""}`,
    });
  }
  return out;
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
    dispute_notes: recordOf(v.dispute_notes),
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
  dispute_notes?: Record<string, string>;
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
  /** S.7, kept out of `s` so an older build still reads every settlement: [id, note, undone]. */
  x?: Array<[string, string | null, string | null]>;
  /** S.7: [bill id, my dispute note]. */
  d?: Array<[string, string]>;
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
    ...(page.settlements.some((x) => x.note || x.undone_at)
      ? {
          x: page.settlements
            .filter((x) => x.note || x.undone_at)
            .map((x): [string, string | null, string | null] => [
              x.id,
              x.note ?? null,
              x.undone_at ?? null,
            ]),
        }
      : {}),
    ...(page.dispute_notes && Object.keys(page.dispute_notes).length
      ? { d: Object.entries(page.dispute_notes) }
      : {}),
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
  const extras = new Map<string, [unknown, unknown]>();
  for (const e of Array.isArray(v.x) ? v.x : [])
    if (Array.isArray(e) && typeof e[0] === "string") extras.set(e[0], [e[1], e[2]]);
  for (const e of Array.isArray(v.d) ? v.d : [])
    if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") {
      page.dispute_notes ??= {};
      page.dispute_notes[e[0]] = e[1];
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
    const extra = extras.get(id as string);
    const added = page.settlements[page.settlements.length - 1];
    if (extra && added) {
      if (typeof extra[0] === "string") added.note = extra[0];
      if (typeof extra[1] === "string") added.undone_at = extra[1];
    }
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
    Object.assign(out.dispute_notes as Record<string, string>, page.dispute_notes ?? {});
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
    out.set(m, {
      ...emptyPage(),
      edits: { ...page.edits },
      approved: { ...page.approved },
      ...(page.dispute_notes ? { dispute_notes: { ...page.dispute_notes } } : {}),
    });
  if (!out.has(month)) out.set(month, emptyPage());
  const pageOf = (m: string) => out.get(m) ?? (out.set(m, emptyPage()).get(m) as LedgerPage);

  const lastById = <T extends { id: string }>(list: T[]) => [
    ...new Map(list.map((x) => [x.id, x])).values(),
  ];
  for (const b of lastById(next.bills)) pageOf(billAt.get(b.id) ?? month).bills.push(b);
  for (const s of lastById(next.settlements))
    pageOf(settledAt.get(s.id) ?? month).settlements.push(s);

  const place = <T>(
    field: "edits" | "approved" | "dispute_notes",
    old: Record<string, T>,
    now: Record<string, T>,
  ) => {
    for (const [id, value] of Object.entries(now)) {
      if (Object.hasOwn(old, id) && canonical(old[id]) === canonical(value)) continue;
      const page = pageOf(month);
      page[field] ??= {};
      (page[field] as Record<string, T>)[id] = value;
    }
    for (const id of Object.keys(old)) {
      if (Object.hasOwn(now, id)) continue;
      for (const page of out.values())
        if (page[field]) delete (page[field] as Record<string, T>)[id];
    }
  };
  place("edits", was.edits, recordOf<SplitBill | null>(next.edits));
  place("approved", was.approved ?? {}, recordOf<SplitBill>(next.approved));
  place("dispute_notes", was.dispute_notes ?? {}, recordOf<string>(next.dispute_notes));
  return out;
}
