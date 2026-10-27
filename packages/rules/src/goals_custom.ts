/** Port of stackd_rules/goals_custom.py: a jar with the user's own name, amount and date. */

import { type Day, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { goalEvents, progress } from "./goals.ts";
import { assertInt } from "./money.ts";

export const NAME_MAX = 10; // owner decision, October 10, 2026
const EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g; // ASCII only, same as Python

export interface CustomJar {
  goal: {
    kind: "save";
    title: string;
    target_cents: number;
    start_date: string;
    end_date: string | null;
  };
  days_left: number | null;
  weeks_left: number | null;
  weekly_pace: number | null;
}

export function jar(
  name: unknown,
  targetCents: unknown,
  endDate: unknown,
  asOf: unknown,
): CustomJar {
  if (typeof name !== "string") throw new RuleError("invalid_name");
  const title = name.replace(EDGE_WHITESPACE, "");
  if (title.length === 0 || [...title].length > NAME_MAX) throw new RuleError("invalid_name");
  const target = assertInt(targetCents, "invalid_amount");
  if (target <= 0) throw new RuleError("invalid_amount");
  const today = parseDate(asOf);
  const end: Day | null = endDate === null || endDate === undefined ? null : parseDate(endDate);
  if (end !== null && iso(end) < iso(today)) throw new RuleError("deadline_in_past");
  const goal = {
    kind: "save" as const,
    title,
    target_cents: target,
    start_date: iso(today),
    end_date: end === null ? null : iso(end),
  };
  const pace = progress(goal, [], asOf);
  return {
    goal,
    days_left: pace.days_left,
    weeks_left: pace.weeks_left,
    weekly_pace: pace.weekly_pace,
  };
}

// fast-follow 3: cadence plan, ongoing streak, milestones (see the Python docstring)

import { addDays, addMonths, CADENCES, nextPaydays, periodsUntil } from "./dates.ts";
import { pctOf, roundDiv } from "./money.ts";

const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14 };

function step(day: Day, cadence: string, k: number, schedule: unknown): Day {
  const days = CADENCE_DAYS[cadence];
  if (days !== undefined) return addDays(day, days * k);
  if (cadence === "monthly") return addMonths(day, k);
  if (cadence === "payday") {
    if (schedule === null || schedule === undefined) throw new RuleError("schedule_required");
    if (k === 0) return day;
    const paydays = nextPaydays(day, schedule, k);
    return paydays[paydays.length - 1] as Day;
  }
  throw new RuleError("invalid_cadence");
}

function isCadence(value: unknown): value is (typeof CADENCES)[number] {
  return typeof value === "string" && (CADENCES as readonly string[]).includes(value);
}

export interface Plan {
  remaining_cents: number;
  periods_left: number | null;
  per_period_cents: number | null;
  finish_date: string | null;
  next_date: string;
  needs_amount: boolean;
}

export function plan(
  goal: unknown,
  events: unknown,
  asOf: unknown,
  schedule: unknown = null,
): Plan {
  if (typeof goal !== "object" || goal === null) throw new RuleError("invalid_goal");
  const g = goal as Record<string, unknown>;
  const cadence = g.cadence;
  if (!isCadence(cadence)) throw new RuleError("invalid_cadence");
  const today = parseDate(asOf);
  const base: Record<string, unknown> = {};
  for (const key of ["kind", "target_cents", "start_date", "end_date"])
    if (key in g) base[key] = g[key];
  const remaining = progress(base, events, asOf).remaining;
  const end = g.end_date === null || g.end_date === undefined ? null : parseDate(g.end_date);
  const fixed =
    g.per_period_cents === null || g.per_period_cents === undefined
      ? null
      : assertInt(g.per_period_cents, "invalid_amount");
  if (fixed !== null && fixed < 0) throw new RuleError("invalid_amount");
  const nextDate = iso(step(today, cadence, 1, schedule));
  if (end !== null) {
    const periodsLeft = periodsUntil(today, end, cadence, schedule);
    return {
      remaining_cents: remaining,
      periods_left: periodsLeft,
      per_period_cents: roundDiv(remaining, Math.max(1, periodsLeft)),
      finish_date: iso(end),
      next_date: nextDate,
      needs_amount: false,
    };
  }
  if (fixed) {
    const periodsNeeded = Math.ceil(remaining / fixed);
    const finish = periodsNeeded ? step(today, cadence, periodsNeeded, schedule) : today;
    return {
      remaining_cents: remaining,
      periods_left: periodsNeeded,
      per_period_cents: fixed,
      finish_date: iso(finish),
      next_date: nextDate,
      needs_amount: false,
    };
  }
  return {
    remaining_cents: remaining,
    periods_left: null,
    per_period_cents: null,
    finish_date: null,
    next_date: nextDate,
    needs_amount: true,
  };
}

interface Pause {
  start: string;
  end: string | null;
}

function pauses(raw: unknown): Pause[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RuleError("invalid_pauses");
  return raw.map((p) => {
    if (typeof p !== "object" || p === null) throw new RuleError("invalid_pauses");
    const r = p as Record<string, unknown>;
    const start = iso(parseDate(r.start));
    const end = r.end === null || r.end === undefined ? null : iso(parseDate(r.end));
    if (end !== null && end < start) throw new RuleError("invalid_pauses");
    return { start, end };
  });
}

export interface Streak {
  total_cents: number;
  streak: number;
  periods_complete: number;
  current: { start: string; end: string; saved_cents: number; met: boolean; paused: boolean };
}

export function streak(
  goal: unknown,
  rawEvents: unknown,
  asOf: unknown,
  schedule: unknown = null,
): Streak {
  if (typeof goal !== "object" || goal === null) throw new RuleError("invalid_goal");
  const g = goal as Record<string, unknown>;
  const cadence = g.cadence;
  if (!isCadence(cadence)) throw new RuleError("invalid_cadence");
  const planCents = assertInt(g.per_period_cents, "invalid_amount");
  if (planCents <= 0) throw new RuleError("invalid_amount");
  const today = iso(parseDate(asOf));
  const start = parseDate(g.start_date);
  if (iso(start) > today) throw new RuleError("invalid_goal");
  const pauseList = pauses(g.pauses);
  // The same validation as goals.progress; only money events matter here.
  const rows = goalEvents(rawEvents).filter((e) => e.type === "deposit" || e.type === "withdrawal");
  const signed = (e: { type: string; amount_cents: number | null }) =>
    e.type === "deposit" ? (e.amount_cents ?? 0) : -(e.amount_cents ?? 0);
  const total = rows.reduce((sum, e) => sum + signed(e), 0);
  const bounds: string[] = [iso(start)];
  let k = 1;
  while ((bounds[bounds.length - 1] as string) <= today) {
    const next = iso(step(start, cadence, k, schedule));
    if (next <= (bounds[bounds.length - 1] as string)) throw new RuleError("invalid_schedule");
    bounds.push(next);
    k += 1;
    if (k > 1200) throw new RuleError("invalid_schedule");
  }
  const periods = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const pStart = bounds[i] as string;
    const pEnd = bounds[i + 1] as string;
    const saved = rows
      .filter((e) => pStart <= iso(e.date) && iso(e.date) < pEnd)
      .reduce((sum, e) => sum + signed(e), 0);
    const paused = pauseList.some((p) => p.start < pEnd && (p.end === null || p.end >= pStart));
    periods.push({
      start: pStart,
      end: pEnd,
      saved_cents: saved,
      met: saved >= planCents,
      paused,
      complete: pEnd <= today,
    });
  }
  let run = 0;
  const current = periods[periods.length - 1];
  if (!current) throw new RuleError("invalid_schedule");
  if (current.met && !current.paused) run += 1;
  for (const period of [...periods.slice(0, -1)].reverse()) {
    if (period.paused) continue;
    if (!period.met) break;
    run += 1;
  }
  return {
    total_cents: total,
    streak: run,
    periods_complete: periods.filter((p) => p.complete).length,
    current: {
      start: current.start,
      end: current.end,
      saved_cents: current.saved_cents,
      met: current.met,
      paused: current.paused,
    },
  };
}

export interface Milestone {
  bps: number;
  target_cents: number;
  reached: boolean;
}

export function milestones(
  targetCents: unknown,
  currentCents: unknown,
  checkpointsBps: unknown,
): { milestones: Milestone[] } {
  const target = assertInt(targetCents, "invalid_amount");
  const current = assertInt(currentCents, "invalid_amount");
  if (target <= 0) throw new RuleError("invalid_amount");
  if (!Array.isArray(checkpointsBps) || checkpointsBps.length === 0)
    throw new RuleError("invalid_checkpoints");
  return {
    milestones: checkpointsBps.map((bps) => {
      const value = assertInt(bps, "invalid_checkpoints");
      if (!(value > 0 && value <= 10000)) throw new RuleError("invalid_checkpoints");
      const cents = pctOf(target, value);
      return { bps: value, target_cents: cents, reached: current >= cents };
    }),
  };
}
