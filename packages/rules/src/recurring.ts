/** Port of stackd_rules/recurring.py: recurring series detection (bills and income). */

import { addDays, addMonths, type Day, daysInMonth, daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";
import { assertInt, mul, roundDiv } from "./money.ts";
import { compareText } from "./text.ts";

export const INTERVALS = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export type Interval = (typeof INTERVALS)[number];
const GAPS: Record<Interval, [number, number]> = {
  weekly: [4, 10],
  biweekly: [11, 17],
  monthly: [25, 34],
  quarterly: [80, 100],
  yearly: [350, 380],
};
/** Fast-follow 8: quarterly and yearly runs count from 2 occurrences, the rest from 3. */
const MIN_RUN: Record<Interval, number> = {
  weekly: 3,
  biweekly: 3,
  monthly: 3,
  quarterly: 2,
  yearly: 2,
};
export const DIRECTIONS = ["in", "out"] as const;

export interface RecurringEntry {
  id: string | null;
  date: Day;
  cents: number;
  direction: "in" | "out";
  is_transfer: boolean;
  payee: string;
}

function entry(raw: unknown): RecurringEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_entry");
  const r = raw as Record<string, unknown>;
  const date = parseDate(r.date);
  const cents = assertInt(r.amount_cents);
  if (cents < 0) throw new RuleError("invalid_amount");
  if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
  if (typeof r.is_transfer !== "boolean") throw new RuleError("invalid_entry");
  const id = r.id ?? null;
  if (id !== null && typeof id !== "string") throw new RuleError("invalid_entry");
  return {
    id,
    date,
    cents,
    direction: r.direction,
    is_transfer: r.is_transfer,
    payee: cleanDescription(r.payee),
  };
}

export function entries(raw: unknown): RecurringEntry[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_entries");
  return raw.map(entry);
}

export function intervalOf(gapDays: number): Interval | null {
  for (const name of INTERVALS) {
    const [lo, hi] = GAPS[name];
    if (lo <= gapDays && gapDays <= hi) return name;
  }
  return null;
}

/**
 * One step on, back on the series' own day of the month (1-31, clamped) when it has one, so a
 * short month never drifts it earlier (see Python's step_keeping_day).
 */
export function stepKeepingDay(day: Day, interval: unknown, keep: number | null): Day {
  const stepped = step(day, interval);
  if (
    keep === null ||
    !(interval === "monthly" || interval === "quarterly" || interval === "yearly")
  )
    return stepped;
  return { ...stepped, d: Math.min(keep, daysInMonth(stepped)) };
}

export function step(day: Day, interval: unknown): Day {
  if (interval === "weekly") return addDays(day, 7);
  if (interval === "biweekly") return addDays(day, 14);
  if (interval === "monthly") return addMonths(day, 1);
  if (interval === "quarterly") return addMonths(day, 3);
  if (interval === "yearly") return addMonths(day, 12);
  throw new RuleError("invalid_interval");
}

export function medianCents(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  if (n % 2) return ordered[(n - 1) / 2] as number;
  return roundDiv((ordered[n / 2 - 1] as number) + (ordered[n / 2] as number), 2);
}

export function withinTenPercent(cents: number, reference: number): boolean {
  return mul(9, reference) <= mul(10, cents) && mul(10, cents) <= mul(11, reference);
}

export interface Series {
  payee: string;
  kind: "bill" | "income";
  direction: "in" | "out";
  expected_cents: number;
  interval: Interval;
  last_date: string;
  next_date: string;
  occurrences: number;
  entry_ids: string[];
}

export function detect(rawEntries: unknown, asOf: unknown): { series: Series[] } {
  const today = iso(parseDate(asOf));
  const rows = entries(rawEntries).filter((e) => !e.is_transfer && iso(e.date) <= today);
  const groups = new Map<string, RecurringEntry[]>();
  for (const e of rows) {
    const key = `${e.payee}\u0000${e.direction}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const series: Series[] = [];
  // Python sorts the (payee, direction) tuples: compare the parts, never the joined key.
  const order = [...groups.entries()].sort(
    ([, [a]], [, [b]]) =>
      compareText((a as RecurringEntry).payee, (b as RecurringEntry).payee) ||
      compareText((a as RecurringEntry).direction, (b as RecurringEntry).direction),
  );
  for (const [key] of order) {
    const items = groups.get(key) as RecurringEntry[];
    items.sort(
      (a, b) =>
        compareText(iso(a.date), iso(b.date)) ||
        a.cents - b.cents ||
        compareText(a.id ?? "", b.id ?? ""),
    );
    if (items.length < 2) continue;
    const lastGap = daysUntil(
      (items[items.length - 2] as RecurringEntry).date,
      (items[items.length - 1] as RecurringEntry).date,
    );
    const interval = intervalOf(lastGap);
    if (interval === null) continue;
    const [lo, hi] = GAPS[interval];
    let start = items.length - 2;
    while (start > 0) {
      const gap = daysUntil(
        (items[start - 1] as RecurringEntry).date,
        (items[start] as RecurringEntry).date,
      );
      if (gap < lo || gap > hi) break;
      start -= 1;
    }
    const run = items.slice(start);
    if (run.length < MIN_RUN[interval]) continue;
    const expected = medianCents(run.map((e) => e.cents));
    if (!run.every((e) => withinTenPercent(e.cents, expected))) continue;
    const last = (run[run.length - 1] as RecurringEntry).date;
    const first = run[0] as RecurringEntry;
    series.push({
      payee: first.payee,
      kind: first.direction === "in" ? "income" : "bill",
      direction: first.direction,
      expected_cents: expected,
      interval,
      last_date: iso(last),
      next_date: iso(step(last, interval)),
      occurrences: run.length,
      entry_ids: run.map((e) => e.id).filter((id): id is string => id !== null),
    });
  }
  return { series };
}

export const PER_YEAR: Record<Interval, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};

export interface YearlyItem {
  id: string;
  label: string;
  yearly_cents: number;
  monthly_cents: number;
}

/** Port of recurring.yearly_cost: what each recurring charge costs a year, highest first. */
export function yearlyCost(raw: unknown): {
  items: YearlyItem[];
  yearly_cents: number;
  monthly_cents: number;
} {
  if (!Array.isArray(raw)) throw new RuleError("invalid_series");
  const items: YearlyItem[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null || Array.isArray(s))
      throw new RuleError("invalid_series");
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string")
      throw new RuleError("invalid_series");
    if (typeof r.interval !== "string" || !Object.hasOwn(PER_YEAR, r.interval))
      throw new RuleError("invalid_interval");
    const cents = assertInt(r.expected_cents, "invalid_amount");
    if (cents < 0) throw new RuleError("invalid_amount");
    const yearly = cents * PER_YEAR[r.interval as Interval]; // past 2^53 it is not safe: invalid_amount below
    if (!Number.isSafeInteger(yearly)) throw new RuleError("invalid_amount");
    items.push({
      id: r.id,
      label: r.label,
      yearly_cents: yearly,
      monthly_cents: roundDiv(yearly, 12),
    });
  }
  items.sort(
    (a, b) =>
      b.yearly_cents - a.yearly_cents || compareText(a.label, b.label) || compareText(a.id, b.id),
  );
  const total = items.reduce((sum, i) => sum + i.yearly_cents, 0);
  if (!Number.isSafeInteger(total)) throw new RuleError("invalid_amount");
  return { items, yearly_cents: total, monthly_cents: roundDiv(total, 12) };
}

const CHECK_THRESHOLDS = [
  "subscription_ask_days",
  "subscription_renewal_days",
  "trial_max_cents",
  "trial_window_days",
] as const;
type CheckThresholds = Record<(typeof CHECK_THRESHOLDS)[number], number>;

function checkThresholds(raw: unknown): CheckThresholds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_thresholds");
  const out = {} as CheckThresholds;
  for (const key of CHECK_THRESHOLDS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new RuleError("invalid_thresholds");
    out[key] = value;
  }
  return out;
}

function kindTable(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw)) throw new RuleError("invalid_kinds");
  return raw.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw new RuleError("invalid_kinds");
    const { match, kind } = row as Record<string, unknown>;
    if (typeof match !== "string" || typeof kind !== "string" || kind === "")
      throw new RuleError("invalid_kinds");
    const cleaned = cleanDescription(match);
    if (cleaned === "") throw new RuleError("invalid_kinds");
    return [cleaned, kind] as [string, string];
  });
}

function isWordChar(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
}

/**
 * Port of recurring.contains_word: `word` inside `text` as a whole word (the characters just
 * before and after it, when there are any, are not A-Z or 0-9). Only ASCII is ever compared, so
 * UTF-16 positions give the same answer as Python's code points.
 */
export function containsWord(text: string, word: string): boolean {
  let start = text.indexOf(word);
  while (start !== -1) {
    const end = start + word.length;
    const beforeOk = start === 0 || !isWordChar(text.charAt(start - 1));
    const afterOk = end === text.length || !isWordChar(text.charAt(end));
    if (beforeOk && afterOk) return true;
    start = text.indexOf(word, start + 1);
  }
  return false;
}

/** The person's "Other": no kind, whatever the table says. */
export const OTHER_KIND = "other";

function ownKind(raw: unknown, known: Set<string>): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") throw new RuleError("invalid_kind");
  if (raw !== OTHER_KIND && !known.has(raw)) throw new RuleError("invalid_kind");
  return raw;
}

/** Port of recurring._own_kinds: the person's own kind ids (their names stay on the device). */
function ownKinds(raw: unknown, builtin: Set<string>): Set<string> {
  const out = new Set<string>();
  if (raw === null || raw === undefined) return out;
  if (!Array.isArray(raw)) throw new RuleError("invalid_own_kinds");
  for (const kind of raw) {
    if (typeof kind !== "string" || kind === "" || kind === OTHER_KIND)
      throw new RuleError("invalid_own_kinds");
    if (builtin.has(kind) || out.has(kind)) throw new RuleError("invalid_own_kinds");
    out.add(kind);
  }
  return out;
}

/** Port of recurring._own_words: cleaned like the table's, each naming a known kind. */
function ownWords(raw: unknown, known: Set<string>): Array<[string, string]> {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RuleError("invalid_own_words");
  return raw.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw new RuleError("invalid_own_words");
    const { match, kind } = row as Record<string, unknown>;
    if (typeof match !== "string" || typeof kind !== "string")
      throw new RuleError("invalid_own_words");
    const cleaned = cleanDescription(match);
    if (cleaned === "") throw new RuleError("invalid_own_words");
    if (!known.has(kind)) throw new RuleError("invalid_kind");
    return [cleaned, kind] as [string, string];
  });
}

function charges(raw: unknown): Array<[Day, number]> {
  if (!Array.isArray(raw)) throw new RuleError("invalid_charges");
  return raw.map((c) => {
    if (typeof c !== "object" || c === null || Array.isArray(c))
      throw new RuleError("invalid_charges");
    const r = c as Record<string, unknown>;
    const cents = assertInt(r.cents, "invalid_amount");
    if (cents < 0) throw new RuleError("invalid_amount");
    return [parseDate(r.date), cents] as [Day, number];
  });
}

function answeredSince(checked: Day | null, day: Day): boolean {
  return checked !== null && daysUntil(day, checked) >= 0;
}

export interface SubscriptionCheckItem {
  id: string;
  label: string;
  kind: string | null;
  ask: boolean;
  price_rise: { from_cents: number; to_cents: number; date: string } | null;
  renewal: { date: string; cents: number } | null;
  trial_turned_charge: { trial_cents: number; cents: number; date: string } | null;
  yearly_cents: number;
  monthly_cents: number;
}

export interface SubscriptionCheck {
  items: SubscriptionCheckItem[];
  duplicates: Array<{ kind: string; count: number; monthly_total_cents: number; ids: string[] }>;
  by_kind: Array<{
    kind: string | null;
    count: number;
    yearly_cents: number;
    monthly_cents: number;
    ids: string[];
  }>;
}

/** Port of recurring.subscription_check: facts from the person's own charges, and when to ask. */
export function subscriptionCheck(
  asOf: unknown,
  subscriptions: unknown,
  kinds: unknown,
  thresholds: unknown,
  ownWordsRaw: unknown = null,
  ownKindsRaw: unknown = null,
): SubscriptionCheck {
  const today = parseDate(asOf);
  const limits = checkThresholds(thresholds);
  const table = kindTable(kinds);
  const builtin = new Set(table.map(([, k]) => k));
  const known = new Set([...builtin, ...ownKinds(ownKindsRaw, builtin)]);
  // The person's words first, so their call wins over the table; a kind set by hand wins over both.
  const words = [...ownWords(ownWordsRaw, known), ...table];
  if (!Array.isArray(subscriptions)) throw new RuleError("invalid_series");
  const items: SubscriptionCheckItem[] = [];
  for (const raw of subscriptions) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_series");
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string" || typeof r.payee !== "string")
      throw new RuleError("invalid_series");
    if (typeof r.interval !== "string" || !Object.hasOwn(PER_YEAR, r.interval))
      throw new RuleError("invalid_interval");
    const interval = r.interval as Interval;
    const expected = assertInt(r.expected_cents, "invalid_amount");
    if (expected < 0) throw new RuleError("invalid_amount");
    const yearly = expected * PER_YEAR[interval];
    if (!Number.isSafeInteger(yearly)) throw new RuleError("invalid_amount");
    const nextDate = parseDate(r.next_date);
    const checked =
      r.checked_at === null || r.checked_at === undefined ? null : parseDate(r.checked_at);
    // Python sorts the (date, cents) tuples.
    const list = charges(r.charges)
      .filter(([d]) => daysUntil(d, today) >= 0)
      .sort((a, b) => compareText(iso(a[0]), iso(b[0])) || a[1] - b[1]);

    // A trial: the first charge is at most trial_max_cents and the next one, larger, follows
    // within trial_window_days. That step up is the trial ending, never a price rise.
    const [c0, c1] = list;
    const trialPair =
      c0 !== undefined &&
      c1 !== undefined &&
      c0[1] <= limits.trial_max_cents &&
      c1[1] > c0[1] &&
      daysUntil(c0[0], c1[0]) <= limits.trial_window_days;
    const trial =
      trialPair && c0 && c1 && !answeredSince(checked, c1[0])
        ? { trial_cents: c0[1], cents: c1[1], date: iso(c1[0]) }
        : null;
    // A price rise: the most recent charge above the one before it, shown while every charge
    // since is at that new price and no Keep came on or after the day it went up (see Python).
    let rise: SubscriptionCheckItem["price_rise"] = null;
    let up = -1;
    for (let i = list.length - 1; i > 0; i -= 1) {
      if ((list[i] as [Day, number])[1] > (list[i - 1] as [Day, number])[1]) {
        up = i;
        break;
      }
    }
    if (up > 0 && !(trialPair && up === 1)) {
      const before = list[up - 1] as [Day, number];
      const raised = list[up] as [Day, number];
      const latest = list[list.length - 1] as [Day, number];
      if (latest[1] === raised[1] && !answeredSince(checked, raised[0]))
        rise = { from_cents: before[1], to_cents: latest[1], date: iso(raised[0]) };
    }
    let renewal: SubscriptionCheckItem["renewal"] = null;
    if (interval === "quarterly" || interval === "yearly") {
      let due = nextDate;
      while (daysUntil(due, today) > 0) due = stepKeepingDay(due, interval, nextDate.d);
      if (daysUntil(today, due) <= limits.subscription_renewal_days)
        renewal = { date: iso(due), cents: expected };
    }
    const lastCharge = list.length ? (list[list.length - 1] as [Day, number])[0] : null;
    const ask =
      checked === null ||
      daysUntil(checked, today) >= limits.subscription_ask_days ||
      (renewal !== null && lastCharge !== null && !answeredSince(checked, lastCharge)) ||
      rise !== null ||
      trial !== null;
    const own = ownKind(r.own_kind, known);
    let kind: string | null;
    if (own !== null) kind = own === OTHER_KIND ? null : own;
    else {
      const clean = cleanDescription(r.payee);
      kind = words.find(([word]) => containsWord(clean, word))?.[1] ?? null;
    }
    items.push({
      id: r.id,
      label: r.label,
      kind,
      ask,
      price_rise: rise,
      renewal,
      trial_turned_charge: trial,
      yearly_cents: yearly,
      monthly_cents: roundDiv(yearly, 12),
    });
  }
  items.sort(
    (a, b) =>
      b.yearly_cents - a.yearly_cents || compareText(a.label, b.label) || compareText(a.id, b.id),
  );
  const groups = new Map<string, SubscriptionCheckItem[]>();
  for (const i of items) {
    if (i.kind === null) continue;
    const g = groups.get(i.kind);
    if (g) g.push(i);
    else groups.set(i.kind, [i]);
  }
  const duplicates: SubscriptionCheck["duplicates"] = [];
  for (const [kind, members] of groups) {
    if (members.length < 2) continue;
    const total = members.reduce((s, m) => s + m.yearly_cents, 0);
    if (!Number.isSafeInteger(total)) throw new RuleError("invalid_amount");
    duplicates.push({
      kind,
      count: members.length,
      monthly_total_cents: roundDiv(total, 12),
      ids: members.map((m) => m.id),
    });
  }
  duplicates.sort(
    (a, b) => b.monthly_total_cents - a.monthly_total_cents || compareText(a.kind, b.kind),
  );
  // Where the money goes, by kind (see Python): the no-kind row is kind null, last on a tie.
  const held = new Map<string | null, SubscriptionCheckItem[]>();
  for (const i of items) {
    const g = held.get(i.kind);
    if (g) g.push(i);
    else held.set(i.kind, [i]);
  }
  const byKind: SubscriptionCheck["by_kind"] = [];
  for (const [kind, members] of held) {
    const total = members.reduce((s, m) => s + m.yearly_cents, 0);
    if (!Number.isSafeInteger(total)) throw new RuleError("invalid_amount");
    byKind.push({
      kind,
      count: members.length,
      yearly_cents: total,
      monthly_cents: roundDiv(total, 12),
      ids: members.map((m) => m.id),
    });
  }
  byKind.sort(
    (a, b) =>
      b.yearly_cents - a.yearly_cents ||
      Number(a.kind === null) - Number(b.kind === null) ||
      compareText(a.kind ?? "", b.kind ?? ""),
  );
  return { items, duplicates, by_kind: byKind };
}
