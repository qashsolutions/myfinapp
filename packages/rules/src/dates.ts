/**
 * Port of stackd_rules/dates.py. ISO date strings at the boundary, UTC day numbers inside;
 * never local time. Schedules: {kind: "every_n_days", anchor, n} | {kind: "monthly_days", days}.
 */

import { RuleError } from "./errors.ts";

export interface Day {
  y: number;
  m: number; // 1..12
  d: number;
}

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MS_PER_DAY = 86_400_000;
export const CADENCES = ["weekly", "biweekly", "monthly", "payday"] as const;
export type Cadence = (typeof CADENCES)[number];
const MAX_COUNT = 1000;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function parseDate(value: unknown): Day {
  if (typeof value !== "string" || !ISO.test(value)) throw new RuleError("invalid_date");
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonthOf(y, m))
    throw new RuleError("invalid_date");
  return { y, m, d };
}

export function iso(day: Day): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(day.y, 4)}-${p(day.m, 2)}-${p(day.d, 2)}`;
}

/** Milliseconds since 1970 for a calendar day. Never `Date.UTC`, which reads years 0–99 as
 * 1900–1999; `setUTCFullYear` takes the year as given (invariant 10; October 27, 2026). */
function utcMs(y: number, monthIndex: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, monthIndex, d);
  return t.getTime();
}

export function daysInMonthOf(y: number, m: number): number {
  return new Date(utcMs(y, m, 0)).getUTCDate();
}

export function daysInMonth(day: Day): number {
  return daysInMonthOf(day.y, day.m);
}

function toNumber(day: Day): number {
  return utcMs(day.y, day.m - 1, day.d) / MS_PER_DAY;
}

function fromNumber(n: number): Day {
  const dt = new Date(n * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function addDays(day: Day, days: number): Day {
  return fromNumber(toNumber(day) + days);
}

function compare(a: Day, b: Day): number {
  return toNumber(a) - toNumber(b);
}

/** Python weekday(): Monday = 0 ... Sunday = 6. */
export function weekday(day: Day): number {
  return (new Date(utcMs(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7;
}

export function monthBounds(asOf: Day): [Day, Day] {
  return [
    { y: asOf.y, m: asOf.m, d: 1 },
    { y: asOf.y, m: asOf.m, d: daysInMonth(asOf) },
  ];
}

/** Calendar months forward or back; the day clamps to the target month's length. */
export function addMonths(day: Day, months: unknown): Day {
  if (!isInt(months)) throw new RuleError("invalid_integer");
  const span = day.m - 1 + months;
  const y = day.y + Math.floor(span / 12);
  const m = (((span % 12) + 12) % 12) + 1;
  return { y, m, d: Math.min(day.d, daysInMonthOf(y, m)) };
}

export function daysUntil(asOf: Day, target: Day): number {
  return toNumber(target) - toNumber(asOf);
}

type Schedule =
  | { kind: "every_n_days"; anchor: Day; n: number }
  | { kind: "monthly_days"; days: number[] };

function validatedSchedule(schedule: unknown): Schedule {
  if (typeof schedule !== "object" || schedule === null || Array.isArray(schedule)) {
    throw new RuleError("invalid_schedule");
  }
  const s = schedule as Record<string, unknown>;
  if (s.kind === "every_n_days") {
    const n = s.n;
    if (!isInt(n) || n < 1) throw new RuleError("invalid_schedule");
    let anchor: Day;
    try {
      anchor = parseDate(s.anchor);
    } catch (e) {
      if (e instanceof RuleError) throw new RuleError("invalid_schedule");
      throw e;
    }
    return { kind: "every_n_days", anchor, n };
  }
  if (s.kind === "monthly_days") {
    const days = s.days;
    if (!Array.isArray(days) || days.length === 0) throw new RuleError("invalid_schedule");
    for (const day of days) {
      if (!isInt(day) || day < 1 || day > 31) throw new RuleError("invalid_schedule");
    }
    return { kind: "monthly_days", days: [...new Set(days as number[])].sort((a, b) => a - b) };
  }
  throw new RuleError("invalid_schedule");
}

/** Paydays strictly after asOf, ascending, forever (callers stop iterating). */
export function* iterPaydays(asOf: Day, schedule: unknown): Generator<Day> {
  const s = validatedSchedule(schedule);
  if (s.kind === "every_n_days") {
    const k = Math.floor((toNumber(asOf) - toNumber(s.anchor)) / s.n) + 1;
    let current = addDays(s.anchor, k * s.n);
    while (true) {
      yield current;
      current = addDays(current, s.n);
    }
  }
  let monthStart: Day = { y: asOf.y, m: asOf.m, d: 1 };
  while (true) {
    const last = daysInMonth(monthStart);
    const seen = new Set<number>();
    for (const day of s.days) {
      const actual = Math.min(day, last);
      if (seen.has(actual)) continue;
      seen.add(actual);
      const payday = { y: monthStart.y, m: monthStart.m, d: actual };
      if (compare(payday, asOf) > 0) yield payday;
    }
    monthStart = addMonths(monthStart, 1);
  }
}

export function nextPaydays(asOf: Day, schedule: unknown, count: unknown): Day[] {
  if (!isInt(count) || count < 0 || count > MAX_COUNT) throw new RuleError("invalid_count");
  const out: Day[] = [];
  if (count === 0) {
    validatedSchedule(schedule);
    return out;
  }
  for (const payday of iterPaydays(asOf, schedule)) {
    out.push(payday);
    if (out.length === count) return out;
  }
  return out;
}

/** Smallest k >= 0 with asOf + k periods >= deadline. Deadline on or before asOf -> 0. */
export function periodsUntil(
  asOf: Day,
  deadline: Day,
  cadence: unknown,
  schedule: unknown = null,
): number {
  if (typeof cadence !== "string" || !(CADENCES as readonly string[]).includes(cadence)) {
    throw new RuleError("invalid_cadence");
  }
  const noSchedule = schedule === null || schedule === undefined;
  if (cadence === "payday" && noSchedule) throw new RuleError("schedule_required");
  if (cadence === "payday") validatedSchedule(schedule);
  if (compare(deadline, asOf) <= 0) return 0;
  const days = daysUntil(asOf, deadline);
  if (cadence === "weekly") return Math.floor((days + 6) / 7);
  if (cadence === "biweekly") return Math.floor((days + 13) / 14);
  if (cadence === "monthly") {
    let k = 0;
    while (compare(addMonths(asOf, k), deadline) < 0) k += 1;
    return k;
  }
  let count = 0;
  for (const payday of iterPaydays(asOf, schedule)) {
    if (compare(payday, deadline) > 0) break;
    count += 1;
  }
  return count;
}
