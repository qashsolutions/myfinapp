/**
 * Port of stackd_rules/insights.py (fast-follow 8): safe to spend, categories running above
 * usual, quarterly / yearly bills ahead, and last year's high months coming up again. Integer
 * cents, UTC day numbers, every rounding through roundDiv.
 */

import { addMonths, type Day, daysInMonth, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";
import { assertInt, mul, roundDiv } from "./money.ts";
import { INTERVALS, step } from "./recurring.ts";
import { compareText, trimSpaces } from "./text.ts";

const LUMPY = new Set(["quarterly", "yearly"]);

function threshold(thresholds: unknown, key: string): number {
  if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds))
    throw new RuleError("invalid_thresholds");
  const value = (thresholds as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new RuleError("invalid_thresholds");
  return value;
}

function key(day: Day): string {
  return iso(day).slice(0, 10);
}

function monthKey(day: Day): string {
  return iso(day).slice(0, 7);
}

function monthStart(day: Day): Day {
  return { y: day.y, m: day.m, d: 1 };
}

function withDay(day: Day, d: number): Day {
  return { y: day.y, m: day.m, d };
}

function cmp(a: Day, b: Day): number {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// --- safe to spend -------------------------------------------------------------------------

export interface SafeToSpend {
  safe_cents: number;
  per_day_cents: number;
  until: string;
  days: number;
  lowest_cents: number;
  lowest_date: string;
}

export function safeToSpend(
  days: unknown,
  bufferCents: unknown,
  asOf: unknown,
  until: unknown,
): SafeToSpend {
  const today = parseDate(asOf);
  const last = parseDate(until);
  const buffer = assertInt(bufferCents);
  if (!Array.isArray(days)) throw new RuleError("invalid_days");
  const window: Array<[Day, number]> = [];
  for (const raw of days) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_days");
    const r = raw as Record<string, unknown>;
    const day = parseDate(r.date);
    const balance = assertInt(r.balance_cents);
    if (cmp(today, day) <= 0 && cmp(day, last) <= 0) window.push([day, balance]);
  }
  if (window.length === 0) throw new RuleError("invalid_range");
  window.sort((a, b) => cmp(a[0], b[0]));
  let [lowestDay, lowest] = window[0] as [Day, number];
  for (const [day, balance] of window) {
    if (balance < lowest) {
      lowestDay = day;
      lowest = balance;
    }
  }
  const safe = Math.max(0, lowest - buffer);
  return {
    safe_cents: safe,
    per_day_cents: roundDiv(safe, window.length),
    until: key((window[window.length - 1] as [Day, number])[0]),
    days: window.length,
    lowest_cents: lowest,
    lowest_date: key(lowestDay),
  };
}

// --- spend rows ----------------------------------------------------------------------------

interface SpendRow {
  date: Day;
  net: number;
  category_id: string | null;
}

function spendRows(entries: unknown): SpendRow[] {
  if (!Array.isArray(entries)) throw new RuleError("invalid_entries");
  return entries.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_entry");
    const r = raw as Record<string, unknown>;
    const date = parseDate(r.date);
    const cents = assertInt(r.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
    if (typeof r.is_transfer !== "boolean") throw new RuleError("invalid_entry");
    const kind = r.category_kind ?? null;
    if (kind !== "expense" && kind !== "income" && kind !== null)
      throw new RuleError("invalid_category");
    const category = r.category_id ?? null;
    if (category !== null && typeof category !== "string") throw new RuleError("invalid_category");
    let net = 0;
    if (!r.is_transfer && kind === "expense") net = r.direction === "out" ? cents : -cents;
    return { date, net, category_id: category as string | null };
  });
}

function between(day: Day, start: Day, end: Day): boolean {
  return cmp(start, day) <= 0 && cmp(day, end) <= 0;
}

// --- more than usual -----------------------------------------------------------------------

export interface UsualFlag {
  category_id: string;
  current_cents: number;
  usual_cents: number;
  increase_cents: number;
}

export function vsUsual(
  asOf: unknown,
  entries: unknown,
  thresholds: unknown,
  months: unknown,
): { months_used: number; flagged: UsualFlag[] } {
  const today = parseDate(asOf);
  const floorCents = threshold(thresholds, "usual_increase_cents");
  const floorBps = threshold(thresholds, "usual_increase_bps");
  const lookback = assertInt(months);
  if (lookback < 1) throw new RuleError("invalid_months");
  const rows = spendRows(entries);
  const thisMonth = monthStart(today);
  const current = new Map<string, number>();
  for (const r of rows) {
    if (between(r.date, thisMonth, today) && r.category_id !== null && r.net)
      current.set(r.category_id, (current.get(r.category_id) ?? 0) + r.net);
  }
  let used = 0;
  const past = new Map<string, number>();
  for (let back = 1; back <= lookback; back++) {
    const start = addMonths(thisMonth, -back);
    const end = withDay(start, Math.min(today.d, daysInMonth(start)));
    const monthEnd = withDay(start, daysInMonth(start));
    if (!rows.some((r) => between(r.date, start, monthEnd))) continue;
    used += 1;
    for (const r of rows) {
      if (between(r.date, start, end) && r.category_id !== null && r.net)
        past.set(r.category_id, (past.get(r.category_id) ?? 0) + r.net);
    }
  }
  const flagged: UsualFlag[] = [];
  if (used) {
    for (const [category, now] of current) {
      const usual = roundDiv(past.get(category) ?? 0, used);
      const increase = now - usual;
      if (increase >= floorCents && mul(now, 10000) >= mul(usual, 10000 + floorBps)) {
        flagged.push({
          category_id: category,
          current_cents: now,
          usual_cents: usual,
          increase_cents: increase,
        });
      }
    }
  }
  flagged.sort((a, b) =>
    a.increase_cents !== b.increase_cents
      ? b.increase_cents - a.increase_cents
      : compareText(a.category_id, b.category_id),
  );
  return { months_used: used, flagged };
}

// --- bigger months ahead -------------------------------------------------------------------

export interface LumpyBill {
  payee: string;
  interval: string;
  due_date: string;
  amount_cents: number;
  months_to_save: number;
  per_month_cents: number;
}

export function lumpyBills(
  asOf: unknown,
  series: unknown,
  thresholds: unknown,
  months: unknown,
): { bills: LumpyBill[]; months: Array<{ month: string; total_cents: number; big: boolean }> } {
  const today = parseDate(asOf);
  const bigCents = threshold(thresholds, "lumpy_month_cents");
  const horizon = assertInt(months);
  if (horizon < 1) throw new RuleError("invalid_months");
  if (!Array.isArray(series)) throw new RuleError("invalid_series");
  const firstMonth = monthStart(today);
  const lastMonth = addMonths(firstMonth, horizon - 1);
  const lastDay = withDay(lastMonth, daysInMonth(lastMonth));
  const bills: LumpyBill[] = [];
  const totals = new Map<string, number>();
  for (const raw of series) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_series");
    const r = raw as Record<string, unknown>;
    const interval = r.interval;
    if (typeof interval !== "string" || !(INTERVALS as readonly string[]).includes(interval))
      throw new RuleError("invalid_interval");
    if (r.kind !== "bill" && r.kind !== "income") throw new RuleError("invalid_series");
    const cents = assertInt(r.expected_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    const payee = cleanDescription(r.payee);
    let due = parseDate(r.next_date);
    if (r.kind !== "bill" || !LUMPY.has(interval)) continue;
    while (cmp(due, today) < 0) due = step(due, interval);
    const monthsToSave = (due.y - today.y) * 12 + due.m - today.m + 1;
    bills.push({
      payee,
      interval,
      due_date: key(due),
      amount_cents: cents,
      months_to_save: monthsToSave,
      per_month_cents: roundDiv(cents, monthsToSave),
    });
    let occurrence = due;
    while (cmp(occurrence, lastDay) <= 0) {
      const k = monthKey(occurrence);
      totals.set(k, (totals.get(k) ?? 0) + cents);
      occurrence = step(occurrence, interval);
    }
  }
  bills.sort((a, b) => compareText(a.due_date, b.due_date) || compareText(a.payee, b.payee));
  return {
    bills,
    months: [...totals.keys()].sort().map((month) => ({
      month,
      total_cents: totals.get(month) as number,
      big: (totals.get(month) as number) >= bigCents,
    })),
  };
}

// --- seasonal spikes -----------------------------------------------------------------------

export interface SeasonalFlag {
  month: string;
  last_year_month: string;
  last_year_cents: number;
  usual_cents: number;
  increase_cents: number;
}

export function seasonal(
  asOf: unknown,
  entries: unknown,
  thresholds: unknown,
): { months_of_history: number; flagged: SeasonalFlag[] } {
  const today = parseDate(asOf);
  const floorCents = threshold(thresholds, "seasonal_increase_cents");
  const floorBps = threshold(thresholds, "seasonal_increase_bps");
  const rows = spendRows(entries);
  const thisMonth = monthStart(today);
  const byMonth = new Map<string, number>();
  const withEntries = new Set<string>();
  for (const r of rows) {
    const k = monthKey(r.date);
    withEntries.add(k);
    byMonth.set(k, (byMonth.get(k) ?? 0) + r.net);
  }
  const history: string[] = [];
  for (let back = 1; back <= 12; back++) {
    const k = monthKey(addMonths(thisMonth, -back));
    if (withEntries.has(k)) history.push(k);
  }
  const flagged: SeasonalFlag[] = [];
  if (history.length >= 6) {
    const usual = roundDiv(
      history.reduce((sum, k) => sum + (byMonth.get(k) ?? 0), 0),
      history.length,
    );
    for (const ahead of [1, 2]) {
      const month = addMonths(thisMonth, ahead);
      const lastYear = monthKey(addMonths(month, -12));
      if (!withEntries.has(lastYear)) continue;
      const spent = byMonth.get(lastYear) ?? 0;
      const increase = spent - usual;
      if (increase >= floorCents && mul(spent, 10000) >= mul(usual, 10000 + floorBps)) {
        flagged.push({
          month: monthKey(month),
          last_year_month: lastYear,
          last_year_cents: spent,
          usual_cents: usual,
          increase_cents: increase,
        });
      }
    }
  }
  return { months_of_history: history.length, flagged };
}

export interface TopSpending {
  largest: Array<{ id: string; date: string; amount_cents: number; payee: string | null }>;
  merchants: Array<{
    key: string;
    name: string;
    count: number;
    total_cents: number;
    last_date: string;
  }>;
  count: number;
}

interface TopRow {
  id: string;
  date: string;
  cents: number;
  out: boolean;
  payee: string | null;
  key: string;
}

function topRow(raw: unknown): TopRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_entry");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") throw new RuleError("invalid_entry");
  const cents = assertInt(r.amount_cents, "invalid_amount");
  if (cents < 0) throw new RuleError("invalid_amount");
  if ((r.direction !== "in" && r.direction !== "out") || typeof r.is_transfer !== "boolean")
    throw new RuleError("invalid_entry");
  const payee = r.payee ?? null;
  if (payee !== null && typeof payee !== "string") throw new RuleError("invalid_description");
  return {
    id: r.id,
    date: iso(parseDate(r.date)),
    cents,
    out: r.direction === "out" && !r.is_transfer,
    payee,
    key: payee !== null ? cleanDescription(payee) : "",
  };
}

const byText = compareText;

/** The biggest single amounts out and the merchants paid most often between two dates. */
export function topSpending(
  start: unknown,
  end: unknown,
  rawEntries: unknown,
  limit: unknown,
): TopSpending {
  const first = iso(parseDate(start));
  const last = iso(parseDate(end));
  if (last < first) throw new RuleError("invalid_range");
  const n = assertInt(limit, "invalid_limit");
  if (n < 1 || n > 20) throw new RuleError("invalid_limit");
  if (!Array.isArray(rawEntries)) throw new RuleError("invalid_entries");
  const rows = rawEntries.map(topRow).filter((r) => r.out && first <= r.date && r.date <= last);
  const bySize = [...rows].sort(
    (a, b) => b.cents - a.cents || byText(b.date, a.date) || byText(a.id, b.id),
  );
  const largest = bySize
    .slice(0, n)
    .map((r) => ({ id: r.id, date: r.date, amount_cents: r.cents, payee: r.payee }));
  const groups = new Map<string, TopRow[]>();
  for (const r of rows) {
    if (!r.key) continue;
    const list = groups.get(r.key) ?? [];
    list.push(r);
    groups.set(r.key, list);
  }
  const merchants = [...groups.entries()].map(([key, items]) => {
    // the latest date; on the same day the smallest id
    const latest = [...items].sort(
      (a, b) => byText(b.date, a.date) || byText(a.id, b.id),
    )[0] as TopRow;
    return {
      key,
      name: trimSpaces(latest.payee ?? ""),
      count: items.length,
      total_cents: items.reduce((sum, r) => sum + r.cents, 0),
      last_date: latest.date,
    };
  });
  merchants.sort(
    (a, b) => b.count - a.count || b.total_cents - a.total_cents || byText(a.key, b.key),
  );
  return { largest, merchants: merchants.slice(0, n), count: rows.length };
}
