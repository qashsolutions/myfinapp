/** Port of stackd_rules/goals.py: progress for the four goal kinds, weekly pace, spend-less baseline. */

import { addDays, type Day, daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, ratioBps, roundDiv } from "./money.ts";

const KINDS = ["save", "payoff", "spend_less", "habit"];
const EVENT_TYPES = ["deposit", "withdrawal", "balance_update", "checkin"];

interface Ev {
  type: string;
  date: Day;
  amount_cents: number | null;
  order: number;
}

export function goalEvents(raw: unknown): Ev[] {
  return events(raw);
}

function events(raw: unknown): Ev[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_events");
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null || !EVENT_TYPES.includes((e as Ev).type))
      throw new RuleError("invalid_event");
    const r = e as Record<string, unknown>;
    const date = parseDate(r.date);
    let amount: number | null = null;
    if (r.type === "checkin") {
      if (r.amount_cents !== undefined && r.amount_cents !== null)
        throw new RuleError("invalid_event");
    } else {
      amount = assertInt(r.amount_cents);
      if (amount < 0) throw new RuleError("invalid_amount");
    }
    return { type: r.type as string, date, amount_cents: amount, order: i };
  });
}

function weeklyPace(remaining: number, daysLeft: number | null): [number | null, number | null] {
  if (daysLeft === null) return [null, null];
  const weeks = Math.max(1, Math.ceil(daysLeft / 7));
  return [weeks, roundDiv(remaining, weeks)];
}

export interface GoalProgress {
  kind: string;
  current: number;
  target: number;
  remaining: number;
  progress_bps: number | null;
  display_bps: number;
  days_left: number | null;
  weeks_left: number | null;
  weekly_pace: number | null;
  status: "reached" | "overdue" | "active";
  end_date: string | null;
}

export function progress(goal: unknown, rawEvents: unknown, asOf: unknown): GoalProgress {
  if (
    typeof goal !== "object" ||
    goal === null ||
    !KINDS.includes((goal as { kind: string }).kind)
  ) {
    throw new RuleError("invalid_goal");
  }
  const g = goal as Record<string, unknown>;
  const kind = g.kind as string;
  const today = parseDate(asOf);
  const start = parseDate(g.start_date);
  let end: Day | null =
    g.end_date === null || g.end_date === undefined ? null : parseDate(g.end_date);
  if (end !== null && iso(end) < iso(start)) throw new RuleError("invalid_goal");
  const rows = events(rawEvents);

  let target: number;
  let current: number;
  if (kind === "habit") {
    target = assertInt(g.target_days);
    if (target <= 0) throw new RuleError("invalid_goal");
    if (end === null) end = addDays(start, target - 1);
    const s = iso(start);
    const e = iso(end);
    const checked = new Set<string>();
    for (const ev of rows) {
      const d = iso(ev.date);
      if (ev.type === "checkin" && d >= s && d <= e) checked.add(d);
    }
    current = checked.size;
  } else {
    target = assertInt(g.target_cents);
    if (target <= 0) throw new RuleError("invalid_goal");
    if (kind === "save") {
      current =
        rows
          .filter((ev) => ev.type === "deposit")
          .reduce((sum, ev) => sum + (ev.amount_cents ?? 0), 0) -
        rows
          .filter((ev) => ev.type === "withdrawal")
          .reduce((sum, ev) => sum + (ev.amount_cents ?? 0), 0);
    } else if (kind === "payoff") {
      const updates = rows
        .filter((ev) => ev.type === "balance_update")
        .sort((a, b) => {
          const ka = `${iso(a.date)}|${String(a.order).padStart(9, "0")}`;
          const kb = `${iso(b.date)}|${String(b.order).padStart(9, "0")}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
      const latest = updates.length
        ? (updates[updates.length - 1]?.amount_cents ?? target)
        : target;
      current = target - latest;
    } else {
      const baseline = assertInt(g.baseline_cents);
      const spent = assertInt(g.period_spend_cents);
      current = baseline - spent;
    }
  }

  const daysLeft = end !== null ? daysUntil(today, end) : null;
  const reached = current >= target;
  const remaining = Math.max(0, target - current);
  const [weeksLeft, pace] = weeklyPace(remaining, daysLeft);
  const progressBps = ratioBps(current, target);
  return {
    kind,
    current,
    target,
    remaining,
    progress_bps: progressBps,
    display_bps: Math.max(0, Math.min(10000, progressBps ?? 0)),
    days_left: daysLeft,
    weeks_left: weeksLeft,
    weekly_pace: reached ? 0 : pace,
    status: reached ? "reached" : daysLeft !== null && daysLeft < 0 ? "overdue" : "active",
    end_date: end !== null ? iso(end) : null,
  };
}

export function spendLessBaseline(estimateCents: unknown, previousMonthsCents: unknown): number {
  const estimate = assertInt(estimateCents);
  if (estimate < 0) throw new RuleError("invalid_amount");
  if (!Array.isArray(previousMonthsCents)) throw new RuleError("invalid_history");
  const history = previousMonthsCents.map((v) => assertInt(v));
  if (history.some((v) => v < 0)) throw new RuleError("invalid_amount");
  if (history.length === 0) return estimate;
  const recent = history.slice(-3);
  return roundDiv(
    recent.reduce((s, v) => s + v, 0),
    recent.length,
  );
}
