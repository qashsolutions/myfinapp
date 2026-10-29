/**
 * Port of stackd_rules/whatif.py: one lever moved, the same plan run twice (October 28, 2026).
 * An illustration from the person's own numbers, never advice.
 */

import { type PayoffPlan, payoffPlan } from "./bills.ts";
import { addMonths, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";

const MAX_MONTHS = 1200;

export interface WhatIfSide {
  months: number | null;
  debt_free_month: string | null;
  interest_cents: number | null;
}

export interface WhatIfDebt {
  before: WhatIfSide;
  after: WhatIfSide;
  months_sooner: number | null;
  interest_saved_cents: number | null;
  status: "sooner" | "same" | "stalled";
}

function side(plan: PayoffPlan): WhatIfSide {
  return {
    months: plan.months,
    debt_free_month: plan.debt_free_month,
    interest_cents: plan.total_interest_cents,
  };
}

/** bills.payoff_plan with today's extra, then with `addCents` more each month. */
export function debt(
  debts: unknown,
  extraCents: unknown,
  addCents: unknown,
  asOf: unknown,
  order: unknown = null,
): WhatIfDebt {
  const add = assertInt(addCents, "invalid_amount");
  if (add < 0) throw new RuleError("invalid_amount");
  const before = payoffPlan(debts, extraCents, asOf, order);
  const after = payoffPlan(debts, assertInt(extraCents, "invalid_amount") + add, asOf, order);
  const both = !before.stalled && !after.stalled;
  let status: WhatIfDebt["status"] = "same";
  if (after.stalled) status = "stalled";
  else if (before.stalled || (after.months as number) < (before.months as number))
    status = "sooner";
  return {
    before: side(before),
    after: side(after),
    months_sooner: both ? (before.months as number) - (after.months as number) : null,
    interest_saved_cents: both
      ? (before.total_interest_cents as number) - (after.total_interest_cents as number)
      : null,
    status,
  };
}

export interface WhatIfGoal {
  months_now: number | null;
  months_new: number | null;
  finish_now: string | null;
  finish_new: string | null;
  months_sooner: number | null;
  status: "sooner" | "same" | "never";
}

function monthsTo(remaining: bigint, perMonth: bigint): number | null {
  if (remaining === 0n) return 0;
  if (perMonth === 0n) return null;
  const months = (remaining + perMonth - 1n) / perMonth; // ceiling
  return months <= BigInt(MAX_MONTHS) ? Number(months) : null;
}

function finish(asOf: string, months: number | null): string | null {
  if (months === null) return null;
  const day = addMonths({ ...parseDate(asOf), d: 1 }, months);
  return `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}`;
}

/** Months to fill a jar at today's pace and with `addCents` more a month. */
export function goal(
  remainingCents: unknown,
  perMonthCents: unknown,
  addCents: unknown,
  asOf: unknown,
): WhatIfGoal {
  parseDate(asOf);
  const remaining = assertInt(remainingCents, "invalid_amount");
  const perMonth = assertInt(perMonthCents, "invalid_amount");
  const add = assertInt(addCents, "invalid_amount");
  if (remaining < 0 || perMonth < 0 || add < 0) throw new RuleError("invalid_amount");
  const now = monthsTo(BigInt(remaining), BigInt(perMonth));
  const next = monthsTo(BigInt(remaining), BigInt(perMonth) + BigInt(add));
  let status: WhatIfGoal["status"] = "same";
  if (next === null) status = "never";
  else if (now === null || next < now) status = "sooner";
  return {
    months_now: now,
    months_new: next,
    finish_now: finish(asOf as string, now),
    finish_new: finish(asOf as string, next),
    months_sooner: now !== null && next !== null ? now - next : null,
    status,
  };
}
