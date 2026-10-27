/** Port of stackd_rules/recurring.py: recurring series detection (bills and income). */

import { addDays, addMonths, type Day, daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";
import { assertInt, roundDiv } from "./money.ts";
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
  return 9 * reference <= 10 * cents && 10 * cents <= 11 * reference;
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
