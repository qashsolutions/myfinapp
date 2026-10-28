/** Port of stackd_rules/next_move.py: Home's next move, the set-aside numbers, the payday nudge. */

import { addDays, type Day, daysUntil, iso, monthBounds, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, mul, pctOf, ratioBps, roundDiv } from "./money.ts";

export const RULE_IDS = [
  "shortfall",
  "set_pay",
  "payday_set_aside",
  "starter_fund",
  "high_apr",
  "bill_due",
  "grow_runway",
  "goal_behind_pace",
  "start_goal",
] as const;
export type RuleId = (typeof RULE_IDS)[number];
export const THRESHOLDS = [
  "starter_fund_cents",
  "high_apr_bps",
  "bill_due_within_days",
  "runway_min_tenths",
  "set_aside_share_bps",
] as const;

export interface NextMoveConfig {
  version?: number;
  order: RuleId[];
  thresholds: Record<(typeof THRESHOLDS)[number], number>;
}

export function validateConfig(config: unknown): NextMoveConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new RuleError("invalid_config");
  const c = config as Record<string, unknown>;
  const order = c.order;
  const thresholds = c.thresholds;
  if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length)
    throw new RuleError("invalid_config");
  if (
    order.some((rule) => !(RULE_IDS as readonly unknown[]).includes(rule)) ||
    order[order.length - 1] !== "start_goal"
  )
    throw new RuleError("invalid_config");
  if (typeof thresholds !== "object" || thresholds === null || Array.isArray(thresholds))
    throw new RuleError("invalid_config");
  const t = thresholds as Record<string, unknown>;
  const keys = Object.keys(t).sort();
  if (keys.join(",") !== [...THRESHOLDS].sort().join(",")) throw new RuleError("invalid_config");
  const out: Record<string, number> = {};
  for (const key of THRESHOLDS) {
    const value = assertInt(t[key], "invalid_config");
    if (value < 0) throw new RuleError("invalid_config");
    out[key] = value;
  }
  return { order: order as RuleId[], thresholds: out as NextMoveConfig["thresholds"] };
}

function optionalInt(value: unknown, code = "invalid_integer"): number | null {
  if (value === null || value === undefined) return null;
  const result = assertInt(value, code);
  if (result < 0) throw new RuleError("invalid_amount");
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Facts {
  shortfall: { short_by_cents: number | null; date: string } | null;
  take_home_cents: number | null;
  payday: {
    paycheck_cents: number;
    suggested_cents: number;
    set_aside_this_period: boolean;
  } | null;
  emergency_saved_cents: number | null;
  max_apr_bps: number | null;
  next_bill: { label: string; date: Day; amount_cents: number } | null;
  runway_tenths: number | null;
  behind_goal: { id: string; title: string; per_period_cents: number; behind_cents: number } | null;
}

function facts(raw: unknown): Facts {
  if (!isRecord(raw)) throw new RuleError("invalid_facts");
  let shortfall: Facts["shortfall"] = null;
  if (raw.shortfall !== null && raw.shortfall !== undefined) {
    if (!isRecord(raw.shortfall)) throw new RuleError("invalid_facts");
    shortfall = {
      short_by_cents: optionalInt(raw.shortfall.short_by_cents),
      date: iso(parseDate(raw.shortfall.date)),
    };
  }
  let payday: Facts["payday"] = null;
  if (raw.payday !== null && raw.payday !== undefined) {
    if (!isRecord(raw.payday) || typeof raw.payday.set_aside_this_period !== "boolean")
      throw new RuleError("invalid_facts");
    payday = {
      paycheck_cents: optionalInt(raw.payday.paycheck_cents) ?? 0,
      suggested_cents: optionalInt(raw.payday.suggested_cents) ?? 0,
      set_aside_this_period: raw.payday.set_aside_this_period,
    };
  }
  let behindGoal: Facts["behind_goal"] = null;
  if (raw.behind_goal !== null && raw.behind_goal !== undefined) {
    if (
      !isRecord(raw.behind_goal) ||
      typeof raw.behind_goal.id !== "string" ||
      typeof raw.behind_goal.title !== "string"
    )
      throw new RuleError("invalid_facts");
    behindGoal = {
      id: raw.behind_goal.id,
      title: raw.behind_goal.title,
      per_period_cents: optionalInt(raw.behind_goal.per_period_cents) ?? 0,
      behind_cents: optionalInt(raw.behind_goal.behind_cents) ?? 0,
    };
  }
  let nextBill: Facts["next_bill"] = null;
  if (raw.next_bill !== null && raw.next_bill !== undefined) {
    if (!isRecord(raw.next_bill) || typeof raw.next_bill.label !== "string")
      throw new RuleError("invalid_facts");
    nextBill = {
      label: raw.next_bill.label,
      date: parseDate(raw.next_bill.date),
      amount_cents: optionalInt(raw.next_bill.amount_cents) ?? 0,
    };
  }
  return {
    shortfall,
    take_home_cents: optionalInt(raw.take_home_cents),
    payday,
    emergency_saved_cents: optionalInt(raw.emergency_saved_cents),
    max_apr_bps: optionalInt(raw.max_apr_bps),
    next_bill: nextBill,
    runway_tenths: optionalInt(raw.runway_tenths),
    behind_goal: behindGoal,
  };
}

export interface NextMove {
  id: RuleId;
  params: Record<string, unknown>;
}

export function pick(rawFacts: unknown, config: unknown, asOf: unknown): NextMove {
  const today = parseDate(asOf);
  const cfg = validateConfig(config);
  const t = cfg.thresholds;
  const f = facts(rawFacts);
  for (const rule of cfg.order) {
    if (rule === "shortfall" && f.shortfall !== null)
      return { id: rule, params: { ...f.shortfall } };
    if (rule === "set_pay" && !f.take_home_cents) return { id: rule, params: {} };
    if (
      rule === "payday_set_aside" &&
      f.payday !== null &&
      !f.payday.set_aside_this_period &&
      f.payday.suggested_cents > 0
    )
      return { id: rule, params: { amount_cents: f.payday.suggested_cents } };
    if (
      rule === "starter_fund" &&
      f.emergency_saved_cents !== null &&
      f.emergency_saved_cents < t.starter_fund_cents
    )
      return {
        id: rule,
        params: {
          target_cents: t.starter_fund_cents,
          remaining_cents: t.starter_fund_cents - f.emergency_saved_cents,
        },
      };
    if (rule === "high_apr" && f.max_apr_bps !== null && f.max_apr_bps >= t.high_apr_bps)
      return { id: rule, params: { apr_bps: f.max_apr_bps } };
    if (rule === "bill_due" && f.next_bill !== null) {
      const days = daysUntil(today, f.next_bill.date);
      if (days >= 0 && days <= t.bill_due_within_days)
        return {
          id: rule,
          params: {
            label: f.next_bill.label,
            date: iso(f.next_bill.date),
            amount_cents: f.next_bill.amount_cents,
            days,
          },
        };
    }
    if (rule === "grow_runway" && f.runway_tenths !== null && f.runway_tenths < t.runway_min_tenths)
      return { id: rule, params: { runway_tenths: f.runway_tenths } };
    if (rule === "goal_behind_pace" && f.behind_goal !== null)
      return { id: rule, params: { ...f.behind_goal } };
    if (rule === "start_goal") return { id: rule, params: {} };
  }
  throw new RuleError("invalid_config");
}

export interface SetAside {
  set_aside_cents: number;
  target_cents: number | null;
  progress_bps: number | null;
  paydays: Array<{ date: string; set_aside: boolean; due: boolean }>;
  paydays_so_far: number;
  paydays_set_aside: number;
}

export function setAside(
  deposits: unknown,
  asOf: unknown,
  targetCents: unknown,
  paydays: unknown,
): SetAside {
  const today = parseDate(asOf);
  const [start, end] = monthBounds(today);
  const target = optionalInt(targetCents);
  if (!Array.isArray(deposits) || !Array.isArray(paydays)) throw new RuleError("invalid_deposits");
  const todayIso = iso(today);
  const startIso = iso(start);
  const endIso = iso(end);
  const rows: Array<{ day: string; cents: number }> = [];
  for (const raw of deposits) {
    if (!isRecord(raw)) throw new RuleError("invalid_deposit");
    const day = iso(parseDate(raw.date));
    const cents = assertInt(raw.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    if (day >= startIso && day <= todayIso) rows.push({ day, cents });
  }
  const total = rows.reduce((sum, r) => sum + r.cents, 0);
  const days = [...new Set(paydays.map((p) => iso(parseDate(p))))]
    .filter((d) => d >= startIso && d <= endIso)
    .sort();
  const out: SetAside["paydays"] = [];
  days.forEach((payday, i) => {
    if (payday > todayIso) {
      out.push({ date: payday, set_aside: false, due: false });
      return;
    }
    const periodEnd = i + 1 < days.length ? (days[i + 1] as string) : endIso;
    const done = rows.some(
      (r) =>
        (r.day >= payday && r.day < periodEnd) || (r.day === periodEnd && periodEnd === endIso),
    );
    out.push({ date: payday, set_aside: done, due: true });
  });
  return {
    set_aside_cents: total,
    target_cents: target,
    progress_bps: target ? ratioBps(total, target) : null,
    paydays: out,
    paydays_so_far: out.filter((p) => p.due).length,
    paydays_set_aside: out.filter((p) => p.set_aside).length,
  };
}

export function paydayNudge(
  paycheckCents: unknown,
  targetCents: unknown,
  monthlyTakeHomeCents: unknown,
  shareBps: unknown,
): number {
  const paycheck = assertInt(paycheckCents);
  const target = optionalInt(targetCents);
  const monthly = assertInt(monthlyTakeHomeCents);
  const share = assertInt(shareBps);
  if (paycheck < 0 || monthly < 0 || share < 0) throw new RuleError("invalid_amount");
  if (target !== null && monthly > 0) return roundDiv(mul(target, paycheck), monthly);
  return pctOf(paycheck, share);
}

export { addDays };
