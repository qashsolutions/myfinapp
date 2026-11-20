/**
 * Port of stackd_rules/streaks.py: weekly streaks, Your path and milestones (owner decision,
 * November 19, 2026; invariant 94). Weeks run Monday to Sunday. Same inputs, same outputs and
 * the same error, checked in the same order, as the Python rules.
 */

import { addDays, addMonths, type Day, daysInMonth, iso, parseDate, weekday } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, mul, roundDiv } from "./money.ts";
import { compareText } from "./text.ts";

export const STEPS = [
  "setup",
  "cushion",
  "starter",
  "paid_in_full",
  "debts",
  "three_months",
  "later",
] as const;
export type StepId = (typeof STEPS)[number];
export type WeekState = "kept" | "rest" | "paused" | "skipped" | "open" | "missed" | "before";

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function monday(d: Day): Day {
  return addDays(d, -weekday(d));
}

function quarterKey(d: Day): string {
  return `${d.y}:${Math.floor((d.m - 1) / 3)}`;
}

function quarterStartAfter(d: Day): Day {
  return addMonths({ y: d.y, m: Math.floor((d.m - 1) / 3) * 3 + 1, d: 1 }, 3);
}

function cmp(a: Day, b: Day): number {
  return compareText(iso(a), iso(b));
}

function dateList(raw: unknown, code: string): Day[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RuleError(code);
  return raw.map((v) => parseDate(v));
}

interface Pause {
  start: Day;
  end: Day | null;
}

function pauseList(raw: unknown): Pause[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RuleError("invalid_pauses");
  return raw.map((p) => {
    if (!isRecord(p)) throw new RuleError("invalid_pauses");
    const start = parseDate(p.start);
    const end = p.end === null || p.end === undefined ? null : parseDate(p.end);
    if (end !== null && cmp(end, start) < 0) throw new RuleError("invalid_pauses");
    return { start, end };
  });
}

function sinceOf(since: unknown, today: Day): Day | null {
  if (since === null || since === undefined) return null;
  const first = parseDate(since);
  if (cmp(first, today) > 0) throw new RuleError("invalid_date");
  return first;
}

export interface WeeklyStreak {
  current: number;
  best: number;
  kept_weeks: number;
  this_week: WeekState;
  last_week: WeekState | null;
  held: number;
  can_rest: boolean;
  rest_left: number;
  rests_renew: string;
  weeks: { start: string; state: WeekState }[];
}

export function weekly(
  asOf: unknown,
  since: unknown,
  met: unknown,
  restQuota: unknown,
  shown: unknown,
  rests: unknown = null,
  pauses: unknown = null,
  skips: unknown = null,
): WeeklyStreak {
  const today = parseDate(asOf);
  const first = sinceOf(since, today);
  const quota = assertInt(restQuota, "invalid_amount");
  const count = assertInt(shown, "invalid_amount");
  if (quota < 0 || count < 1 || count > 52) throw new RuleError("invalid_amount");
  const metWeeks = new Set(
    dateList(met, "invalid_dates")
      .filter((d) => cmp(d, today) <= 0)
      .map((d) => iso(monday(d))),
  );
  const skipWeeks = new Set(dateList(skips, "invalid_dates").map((d) => iso(monday(d))));
  const restWeeks = [...new Set(dateList(rests, "invalid_dates").map((d) => iso(monday(d))))].sort(
    compareText,
  );
  const paused = pauseList(pauses);
  const thisWeek = monday(today);
  const firstWeek = first === null ? null : monday(first);

  const overlapsPause = (start: Day): boolean => {
    const end = addDays(start, 6);
    return paused.some((p) => cmp(p.start, end) <= 0 && (p.end === null || cmp(p.end, start) >= 0));
  };

  const baseState = (start: Day): WeekState => {
    if (firstWeek === null || cmp(start, firstWeek) < 0) return "before";
    if (metWeeks.has(iso(start))) return "kept";
    if (overlapsPause(start)) return "paused";
    if (cmp(start, thisWeek) === 0) return "open";
    if (skipWeeks.has(iso(start))) return "skipped";
    return "missed";
  };

  // Rests apply only to a complete week that would otherwise be missed, the first `quota` in
  // each calendar quarter of the week's Monday.
  const applied = new Set<string>();
  const used = new Map<string, number>();
  for (const key of restWeeks) {
    const week = parseDate(key);
    if (cmp(week, thisWeek) >= 0 || baseState(week) !== "missed") continue;
    const q = quarterKey(week);
    if ((used.get(q) ?? 0) >= quota) continue;
    used.set(q, (used.get(q) ?? 0) + 1);
    applied.add(key);
  }

  const state = (start: Day): WeekState => {
    const s = baseState(start);
    if (s !== "missed") return s;
    return applied.has(iso(start)) ? "rest" : "missed";
  };

  let run = 0;
  let best = 0;
  let kept = 0;
  let prevRun = 0;
  if (firstWeek !== null) {
    let week = firstWeek;
    while (cmp(week, thisWeek) < 0) {
      const s = state(week);
      prevRun = run;
      if (s === "kept") {
        run += 1;
        kept += 1;
      } else if (s === "missed") {
        run = 0;
      }
      best = Math.max(best, run);
      week = addDays(week, 7);
    }
  }
  const nowState = state(thisWeek);
  const current = run + (nowState === "kept" ? 1 : 0);
  if (nowState === "kept") kept += 1;
  best = Math.max(best, current);
  const last = addDays(thisWeek, -7);
  const lastState = firstWeek === null || cmp(last, firstWeek) < 0 ? null : state(last);
  const held = lastState === "missed" ? prevRun : 0;
  const canRest = lastState === "missed" && (used.get(quarterKey(last)) ?? 0) < quota;
  const weeks: { start: string; state: WeekState }[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const start = addDays(thisWeek, -7 * k);
    weeks.push({ start: iso(start), state: state(start) });
  }
  return {
    current,
    best,
    kept_weeks: kept,
    this_week: nowState,
    last_week: lastState,
    held,
    can_rest: canRest,
    rest_left: Math.max(0, quota - (used.get(quarterKey(today)) ?? 0)),
    rests_renew: iso(quarterStartAfter(today)),
    weeks,
  };
}

function* completeWeeks(first: Day | null, today: Day): Generator<Day> {
  if (first === null) return;
  let week = monday(first);
  while (cmp(addDays(week, 6), today) < 0) {
    yield week;
    week = addDays(week, 7);
  }
}

function entryList(raw: unknown): Rec[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_entries");
  return raw.map((e) => {
    if (!isRecord(e)) throw new RuleError("invalid_entries");
    return e;
  });
}

export interface WeekMarks {
  met: string[];
  skips: string[];
}

export function underPlan(
  asOf: unknown,
  since: unknown,
  plans: unknown,
  entries: unknown,
): WeekMarks {
  const today = parseDate(asOf);
  const first = sinceOf(since, today);
  if (!Array.isArray(plans)) throw new RuleError("invalid_plans");
  const byMonth = new Map<string, number>();
  for (const p of plans) {
    if (!isRecord(p)) throw new RuleError("invalid_plans");
    const month = p.month;
    if (typeof month !== "string" || byMonth.has(month)) throw new RuleError("invalid_plans");
    parseDate(`${month}-01`);
    byMonth.set(month, assertInt(p.planned_cents, "invalid_amount"));
  }
  const rows: { date: Day; cents: bigint }[] = [];
  for (const e of entryList(entries)) {
    const direction = e.direction;
    if (direction !== "in" && direction !== "out") throw new RuleError("invalid_direction");
    const cents = assertInt(e.amount_cents, "invalid_amount");
    rows.push({ date: parseDate(e.date), cents: BigInt(direction === "out" ? cents : -cents) });
  }
  const met: string[] = [];
  const skips: string[] = [];
  for (const week of completeWeeks(first, today)) {
    const end = addDays(week, 6);
    const plan = byMonth.get(iso(end).slice(0, 7));
    if (plan === undefined || plan <= 0) {
      skips.push(iso(week));
      continue;
    }
    const start: Day = { y: end.y, m: end.m, d: 1 };
    let spent = 0n;
    for (const r of rows) {
      if (cmp(start, r.date) <= 0 && cmp(r.date, end) <= 0) spent += r.cents;
    }
    const allowed = roundDiv(mul(plan, end.d), daysInMonth(end));
    if (spent <= BigInt(allowed)) met.push(iso(week));
  }
  return { met, skips };
}

export function sortedWeeks(asOf: unknown, since: unknown, entries: unknown): WeekMarks {
  const today = parseDate(asOf);
  const first = sinceOf(since, today);
  const rows: { date: Day; done: boolean }[] = [];
  for (const e of entryList(entries)) {
    const done = e.sorted;
    if (typeof done !== "boolean") throw new RuleError("invalid_entries");
    rows.push({ date: parseDate(e.date), done });
  }
  const met: string[] = [];
  const skips: string[] = [];
  for (const week of completeWeeks(first, today)) {
    const end = addDays(week, 6);
    const mine = rows.filter((r) => cmp(week, r.date) <= 0 && cmp(r.date, end) <= 0);
    if (mine.length === 0) skips.push(iso(week));
    else if (mine.every((r) => r.done)) met.push(iso(week));
  }
  return { met, skips };
}

export type DueResult = "on_time" | "missed" | "unknown";

export interface OnTimeRun {
  current: number;
  best: number;
  checked: number;
  last_missed: string | null;
  shown: { due_date: string; result: DueResult }[];
}

export function onTime(dues: unknown, shown: unknown): OnTimeRun {
  const count = assertInt(shown, "invalid_amount");
  if (count < 1 || count > 52) throw new RuleError("invalid_amount");
  if (!Array.isArray(dues)) throw new RuleError("invalid_dues");
  const rows: { when: string; rank: number; result: DueResult }[] = [];
  for (const d of dues) {
    if (!isRecord(d) || (d.result !== "on_time" && d.result !== "missed" && d.result !== "unknown"))
      throw new RuleError("invalid_dues");
    const when = iso(parseDate(d.due_date));
    // Same day: a missed one sorts after an on-time one, so it breaks the run.
    if (d.result !== "unknown")
      rows.push({ when, rank: d.result === "missed" ? 1 : 0, result: d.result });
  }
  rows.sort((a, b) => compareText(a.when, b.when) || a.rank - b.rank);
  let run = 0;
  let best = 0;
  for (const r of rows) {
    run = r.result === "on_time" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const missed = rows.filter((r) => r.result === "missed");
  return {
    current: run,
    best,
    checked: rows.length,
    last_missed: missed.at(-1)?.when ?? null,
    shown: rows.slice(-count).map((r) => ({ due_date: r.when, result: r.result })),
  };
}

function boolFact(facts: Rec, key: string): boolean {
  const value = facts[key];
  if (typeof value !== "boolean") throw new RuleError("invalid_facts");
  return value;
}

function optFact(facts: Rec, key: string): number | null {
  const value = facts[key];
  return value === null || value === undefined ? null : assertInt(value, "invalid_facts");
}

function reachedMap(raw: unknown, today: Day): Map<string, Day> {
  const out = new Map<string, Day>();
  if (raw === null || raw === undefined) return out;
  if (!isRecord(raw)) throw new RuleError("invalid_reached");
  for (const [key, value] of Object.entries(raw)) {
    const when = parseDate(value);
    if (cmp(when, today) > 0) throw new RuleError("invalid_date");
    out.set(key, when);
  }
  return out;
}

function threshold(thresholds: unknown, key: string): number {
  if (!isRecord(thresholds)) throw new RuleError("invalid_thresholds");
  const value = assertInt(thresholds[key], "invalid_thresholds");
  if (value < 0) throw new RuleError("invalid_thresholds");
  return value;
}

interface StepFacts {
  met: boolean;
  have: number | null;
  need: number;
  clear: boolean;
}

function pathFacts(facts: unknown, thresholds: unknown): Record<StepId, StepFacts> {
  if (!isRecord(facts)) throw new RuleError("invalid_facts");
  const parts = ["pay_set", "budget_set", "balance_set"].filter((k) => boolFact(facts, k)).length;
  const ownCushion = optFact(facts, "cushion_cents");
  const cushion = ownCushion ? ownCushion : threshold(thresholds, "cushion_cents");
  const balance = optFact(facts, "balance_cents");
  const starter = threshold(thresholds, "starter_cents");
  const saved = assertInt(facts.emergency_saved_cents, "invalid_facts");
  const monthsNeed = threshold(thresholds, "paid_in_full_months");
  const hasCards = boolFact(facts, "has_cards");
  const months = optFact(facts, "paid_in_full_months");
  const debts = assertInt(facts.debts_cents, "invalid_facts");
  const runwayNeed = threshold(thresholds, "runway_tenths");
  const runway = optFact(facts, "runway_tenths");
  const later = assertInt(facts.later_cents, "invalid_facts");
  return {
    setup: { met: parts === 3, have: parts, need: 3, clear: false },
    cushion: {
      met: balance !== null && balance >= cushion,
      have: balance,
      need: cushion,
      clear: false,
    },
    starter: { met: saved >= starter, have: saved, need: starter, clear: false },
    paid_in_full: {
      met: !hasCards || (months !== null && months >= monthsNeed),
      have: hasCards ? months : null,
      need: monthsNeed,
      clear: !hasCards,
    },
    debts: { met: debts === 0, have: debts, need: 0, clear: false },
    three_months: {
      met: runway !== null && runway >= runwayNeed,
      have: runway,
      need: runwayNeed,
      clear: false,
    },
    later: { met: later > 0, have: later, need: 1, clear: false },
  };
}

export interface PathStep {
  id: StepId;
  state: "done" | "current" | "next" | "skipped";
  reached_on: string | null;
  met_now: boolean;
  clear: boolean;
  have: number | null;
  need: number;
}

export interface PathResult {
  steps: PathStep[];
  done: number;
  total: number;
  current: StepId | null;
  newly_reached: StepId[];
}

function isStep(v: unknown): v is StepId {
  return (STEPS as readonly unknown[]).includes(v);
}

export function path(
  asOf: unknown,
  facts: unknown,
  thresholds: unknown,
  reached: unknown = null,
  order: unknown = null,
  skipped: unknown = null,
): PathResult {
  const today = parseDate(asOf);
  const known = reachedMap(reached, today);
  const steps = pathFacts(facts, thresholds);
  if (order !== null && order !== undefined && !Array.isArray(order))
    throw new RuleError("invalid_order");
  if (skipped !== null && skipped !== undefined && !Array.isArray(skipped))
    throw new RuleError("invalid_order");
  const ordered: StepId[] = [];
  for (const sid of (order as unknown[] | null) ?? []) {
    if (isStep(sid) && !ordered.includes(sid)) ordered.push(sid);
  }
  for (const s of STEPS) if (!ordered.includes(s)) ordered.push(s);
  const skip = new Set(((skipped as unknown[] | null) ?? []).filter(isStep));
  const out: PathStep[] = [];
  const newly: StepId[] = [];
  let currentFound = false;
  let done = 0;
  for (const sid of ordered) {
    const info = steps[sid];
    let when = known.get(sid) ?? null;
    if (when === null && info.met) {
      when = today;
      newly.push(sid);
    }
    let state: PathStep["state"];
    if (skip.has(sid)) state = "skipped";
    else if (when !== null) {
      state = "done";
      done += 1;
    } else if (!currentFound) {
      state = "current";
      currentFound = true;
    } else state = "next";
    out.push({
      id: sid,
      state,
      reached_on: when === null ? null : iso(when),
      met_now: info.met,
      clear: info.clear,
      have: info.have,
      need: info.need,
    });
  }
  return {
    steps: out,
    done,
    total: STEPS.length - skip.size,
    current: out.find((s) => s.state === "current")?.id ?? null,
    newly_reached: newly,
  };
}

export interface Milestone {
  id: string;
  reached_on: string | null;
  have: number | null;
  need: number;
}

export interface MilestonesResult {
  milestones: Milestone[];
  reached: number;
  newly_reached: string[];
}

export function milestones(
  asOf: unknown,
  facts: unknown,
  thresholds: unknown,
  reached: unknown = null,
): MilestonesResult {
  const today = parseDate(asOf);
  const known = reachedMap(reached, today);
  if (!isRecord(facts) || !isRecord(thresholds)) throw new RuleError("invalid_facts");
  const rawWeeks = thresholds.streak_weeks;
  if (!Array.isArray(rawWeeks) || rawWeeks.length === 0) throw new RuleError("invalid_thresholds");
  const weeks = rawWeeks.map((n) => assertInt(n, "invalid_thresholds"));
  const starter = threshold(thresholds, "starter_cents");
  const onTimeNeed = threshold(thresholds, "on_time_payments");
  const monthsNeed = threshold(thresholds, "paid_in_full_months");
  const runwayNeed = threshold(thresholds, "runway_tenths");
  const jarsNeed = threshold(thresholds, "jars_cents");

  const jars = assertInt(facts.jars, "invalid_facts");
  const saved = assertInt(facts.emergency_saved_cents, "invalid_facts");
  const bestAside = assertInt(facts.best_set_aside, "invalid_facts");
  const keptMonth = assertInt(facts.last_month_kept_cents, "invalid_facts");
  const bestOnTime = assertInt(facts.best_on_time, "invalid_facts");
  const entries = assertInt(facts.entries, "invalid_facts");
  const toSort = assertInt(facts.to_sort, "invalid_facts");
  const challenges = assertInt(facts.challenges_reached, "invalid_facts");
  const hasCards = boolFact(facts, "has_cards");
  const months = optFact(facts, "paid_in_full_months");
  const listed = boolFact(facts, "debts_listed");
  const debts = assertInt(facts.debts_cents, "invalid_facts");
  const runway = optFact(facts, "runway_tenths");
  const jarCents = assertInt(facts.jars_saved_cents, "invalid_facts");

  const rows: [string, boolean, number | null, number][] = [
    ["first_jar", jars >= 1, jars, 1],
    ["starter_fund", saved >= starter, saved, starter],
    ...weeks.map((n): [string, boolean, number | null, number] => [
      `streak_${n}`,
      bestAside >= n,
      bestAside,
      n,
    ]),
    ["kept_month", keptMonth > 0, keptMonth, 1],
    [`on_time_${onTimeNeed}`, bestOnTime >= onTimeNeed, bestOnTime, onTimeNeed],
    ["all_sorted", entries >= 1 && toSort === 0, toSort, 0],
    ["challenge_done", challenges >= 1, challenges, 1],
    ["paid_in_full", hasCards && months !== null && months >= monthsNeed, months, monthsNeed],
    ["debts_gone", listed && debts === 0, debts, 0],
    ["three_months", runway !== null && runway >= runwayNeed, runway, runwayNeed],
    ["jars_total", jarCents >= jarsNeed, jarCents, jarsNeed],
  ];
  const out: Milestone[] = [];
  const newly: string[] = [];
  for (const [id, met, have, need] of rows) {
    let when = known.get(id) ?? null;
    if (when === null && met) {
      when = today;
      newly.push(id);
    }
    out.push({ id, reached_on: when === null ? null : iso(when), have, need });
  }
  return {
    milestones: out,
    reached: out.filter((m) => m.reached_on !== null).length,
    newly_reached: newly,
  };
}
