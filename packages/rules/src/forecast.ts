/** Port of stackd_rules/forecast.py: typical daily spending, starting balance, upcoming, projection. */

import { addDays, type Day, daysInMonth, daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";
import { assertInt, mul, roundDiv, safeNumber } from "./money.ts";
import {
  INTERVALS,
  type Interval,
  entries as recurringEntries,
  step,
  withinTenPercent,
} from "./recurring.ts";
import { compareText } from "./text.ts";

const MAX_DAYS = 366;

function days(value: unknown): number {
  const n = assertInt(value, "invalid_days");
  if (n < 1 || n > MAX_DAYS) throw new RuleError("invalid_days");
  return n;
}

export interface TypicalDaily {
  cents_per_day: number;
  basis: "history" | "budget" | "none";
  days_of_history: number;
}

export function typicalDailySpending(
  rawEntries: unknown,
  asOf: unknown,
  fallbackMonthlyCents: unknown,
): TypicalDaily {
  const today = parseDate(asOf);
  const fallback = assertInt(fallbackMonthlyCents);
  if (fallback < 0) throw new RuleError("invalid_amount");
  if (!Array.isArray(rawEntries)) throw new RuleError("invalid_entries");
  const rows = rawEntries.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_entry");
    const r = raw as Record<string, unknown>;
    const day = parseDate(r.date);
    const cents = assertInt(r.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
    if (typeof r.is_transfer !== "boolean" || typeof r.is_recurring !== "boolean")
      throw new RuleError("invalid_entry");
    return {
      day,
      cents,
      direction: r.direction,
      isTransfer: r.is_transfer,
      isRecurring: r.is_recurring,
    };
  });
  const todayIso = iso(today);
  const history = rows.filter((r) => iso(r.day) <= todayIso);
  let daysOfHistory = 0;
  if (history.length > 0) {
    const earliest = history.map((r) => iso(r.day)).sort()[0] as string;
    daysOfHistory = daysUntil(parseDate(earliest), today) + 1;
  }
  if (daysOfHistory < 30) {
    if (fallback === 0) return { cents_per_day: 0, basis: "none", days_of_history: daysOfHistory };
    return {
      cents_per_day: roundDiv(fallback, daysInMonth(today)),
      basis: "budget",
      days_of_history: daysOfHistory,
    };
  }
  const windowStart = iso(addDays(today, -89));
  let spent = 0;
  for (const r of rows) {
    const d = iso(r.day);
    if (
      d >= windowStart &&
      d <= todayIso &&
      r.direction === "out" &&
      !r.isTransfer &&
      !r.isRecurring
    )
      spent += r.cents;
  }
  return { cents_per_day: roundDiv(spent, 90), basis: "history", days_of_history: daysOfHistory };
}

export interface StartBalance {
  balance_cents: number | null;
  as_of: string | null;
  entries_since: number;
}

export function startBalance(anchor: unknown, rawEntries: unknown): StartBalance {
  if (anchor === null || anchor === undefined)
    return { balance_cents: null, as_of: null, entries_since: 0 };
  if (typeof anchor !== "object" || Array.isArray(anchor)) throw new RuleError("invalid_anchor");
  const a = anchor as Record<string, unknown>;
  const anchored = parseDate(a.as_of);
  let balance = assertInt(a.balance_cents);
  if (!Array.isArray(rawEntries)) throw new RuleError("invalid_entries");
  let counted = 0;
  for (const raw of rawEntries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_entry");
    const r = raw as Record<string, unknown>;
    const day = parseDate(r.date);
    const cents = assertInt(r.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
    if (iso(day) <= iso(anchored)) continue;
    balance += r.direction === "in" ? cents : -cents;
    counted += 1;
  }
  return { balance_cents: balance, as_of: iso(anchored), entries_since: counted };
}

interface SeriesIn {
  id: string;
  payee: string;
  kind: "bill" | "income";
  interval: Interval;
  cents: number;
  next: Day;
  /** The day of the month a monthly, quarterly or yearly series keeps (31 = the last day). */
  day: number | null;
}

function series(raw: unknown): SeriesIn {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_series");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") throw new RuleError("invalid_series");
  if (r.kind !== "bill" && r.kind !== "income") throw new RuleError("invalid_series");
  if (typeof r.interval !== "string" || !(INTERVALS as readonly string[]).includes(r.interval))
    throw new RuleError("invalid_interval");
  const cents = assertInt(r.expected_cents);
  if (cents < 0) throw new RuleError("invalid_amount");
  let keep: number | null = null;
  if (r.day !== undefined && r.day !== null) {
    keep = assertInt(r.day, "invalid_series");
    if (keep < 1 || keep > 31 || r.interval === "weekly" || r.interval === "biweekly")
      throw new RuleError("invalid_series");
  }
  return {
    day: keep,
    id: r.id,
    payee: cleanDescription(r.payee),
    kind: r.kind,
    interval: r.interval as Interval,
    cents,
    next: parseDate(r.next_date),
  };
}

export interface UpcomingItem {
  date: string;
  series_id: string;
  payee: string;
  kind: "bill" | "income";
  amount_cents: number;
  matched: boolean;
  entry_id: string | null;
}

export interface Upcoming {
  start: string;
  end: string;
  items: UpcomingItem[];
}

/** One step on, back on the series' own day of the month when it has one (clamped). */
function nextOf(day: Day, s: SeriesIn): Day {
  const stepped = step(day, s.interval);
  return s.day === null ? stepped : { ...stepped, d: Math.min(s.day, daysInMonth(stepped)) };
}

export function upcoming(
  rawSeries: unknown,
  rawEntries: unknown,
  asOf: unknown,
  rawDays: unknown,
): Upcoming {
  const today = parseDate(asOf);
  const horizon = days(rawDays);
  const end = addDays(today, horizon);
  if (!Array.isArray(rawSeries)) throw new RuleError("invalid_series");
  const rows = recurringEntries(rawEntries);
  const todayIso = iso(today);
  const endIso = iso(end);
  const items: Array<UpcomingItem & { day: Day }> = [];
  for (const s of rawSeries.map(series)) {
    let day = s.next;
    while (iso(day) < todayIso) day = nextOf(day, s);
    while (iso(day) <= endIso) {
      items.push({
        day,
        date: iso(day),
        series_id: s.id,
        payee: s.payee,
        kind: s.kind,
        amount_cents: s.cents,
        matched: false,
        entry_id: null,
      });
      day = nextOf(day, s);
    }
  }
  items.sort(
    (a, b) =>
      compareText(a.date, b.date) ||
      compareText(a.payee, b.payee) ||
      compareText(a.series_id, b.series_id),
  );
  const used = new Set<number>();
  for (const item of items) {
    const direction = item.kind === "income" ? "in" : "out";
    for (let index = 0; index < rows.length; index += 1) {
      const e = rows[index] as (typeof rows)[number];
      if (used.has(index) || e.is_transfer || e.direction !== direction) continue;
      if (e.payee !== item.payee || Math.abs(daysUntil(item.day, e.date)) > 3) continue;
      if (!withinTenPercent(e.cents, item.amount_cents)) continue;
      used.add(index);
      item.matched = true;
      item.entry_id = e.id;
      break;
    }
  }
  return {
    start: todayIso,
    end: endIso,
    items: items.map(({ day: _day, ...rest }) => rest),
  };
}

export interface Projection {
  days: Array<{ date: string; balance_cents: number }>;
  lowest_cents: number;
  lowest_date: string;
  end_cents: number;
  shortfall: boolean;
  short_by_cents: number;
  first_short_date: string | null;
}

export function project(
  asOf: unknown,
  startBalanceCents: unknown,
  dailyCents: unknown,
  upcomingItems: unknown,
  bufferCents: unknown,
  rawDays: unknown,
): Projection {
  const today = parseDate(asOf);
  const start = assertInt(startBalanceCents);
  const daily = assertInt(dailyCents);
  const buffer = assertInt(bufferCents);
  if (daily < 0) throw new RuleError("invalid_amount");
  const horizon = days(rawDays);
  if (!Array.isArray(upcomingItems)) throw new RuleError("invalid_items");
  const expected: Array<{ when: string; cents: number }> = [];
  for (const raw of upcomingItems) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new RuleError("invalid_item");
    const r = raw as Record<string, unknown>;
    if (r.kind !== "bill" && r.kind !== "income") throw new RuleError("invalid_item");
    if (typeof r.matched !== "boolean") throw new RuleError("invalid_item");
    if (r.matched) continue;
    const cents = assertInt(r.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    expected.push({ when: iso(parseDate(r.date)), cents: r.kind === "income" ? cents : -cents });
  }
  const out: Projection["days"] = [];
  let lowest = start;
  let lowestDate = iso(today);
  let firstShort: string | null = start >= buffer ? null : iso(today);
  for (let d = 0; d <= horizon; d += 1) {
    const day = iso(addDays(today, d));
    let balance = safeNumber(BigInt(start) - mul(daily, d));
    for (const item of expected) if (item.when <= day) balance += item.cents;
    out.push({ date: day, balance_cents: balance });
    if (balance < lowest) {
      lowest = balance;
      lowestDate = day;
    }
    if (firstShort === null && balance < buffer) firstShort = day;
  }
  return {
    days: out,
    lowest_cents: lowest,
    lowest_date: lowestDate,
    end_cents: (out[out.length - 1] as { balance_cents: number }).balance_cents,
    shortfall: lowest < buffer,
    short_by_cents: Math.max(0, buffer - lowest),
    first_short_date: firstShort,
  };
}
