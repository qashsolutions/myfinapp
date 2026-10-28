/** Port of stackd_rules/emergency.py: runway, ETA and milestones for the emergency jar. */

import { RuleError } from "./errors.ts";
import { assertInt, ratioBps, roundDiv } from "./money.ts";

export const MIN_TARGET_MONTHS = 1;
export const MAX_TARGET_MONTHS = 12;
export const STARTER_CENTS = 100000;

function amount(value: unknown): number {
  const cents = assertInt(value);
  if (cents < 0) throw new RuleError("invalid_amount");
  return cents;
}

export function runwayTenths(savedCents: unknown, essentialsCents: unknown): number | null {
  const saved = amount(savedCents);
  const essentials = amount(essentialsCents);
  if (essentials === 0) return null;
  return roundDiv(saved * 10, essentials);
}

export function etaMonths(
  savedCents: unknown,
  targetCents: unknown,
  monthlyPlanCents: unknown,
): number | null {
  const saved = amount(savedCents);
  const target = amount(targetCents);
  const plan = amount(monthlyPlanCents);
  if (target <= saved) return 0;
  if (plan === 0) return null;
  return Math.ceil((target - saved) / plan);
}

export interface Milestone {
  key: "starter" | "one_month" | "target";
  target_cents: number;
  progress_bps: number;
  reached: boolean;
  eta_months: number | null;
  months?: number;
}

export interface EmergencySummary {
  saved_cents: number;
  essentials_cents: number;
  runway_tenths: number | null;
  target_months: number;
  monthly_plan_cents: number;
  milestones: Milestone[];
}

export function summary(
  savedCents: unknown,
  essentialsCents: unknown,
  targetMonths: unknown,
  monthlyPlanCents: unknown,
): EmergencySummary {
  const saved = amount(savedCents);
  const essentials = amount(essentialsCents);
  const plan = amount(monthlyPlanCents);
  const months = assertInt(targetMonths);
  if (months < MIN_TARGET_MONTHS || months > MAX_TARGET_MONTHS)
    throw new RuleError("invalid_target");
  const milestone = (
    key: Milestone["key"],
    target: number,
    extra: Partial<Milestone> = {},
  ): Milestone => ({
    key,
    target_cents: target,
    progress_bps: Math.min(10000, ratioBps(saved, target) ?? 0),
    reached: saved >= target,
    eta_months: etaMonths(saved, target, plan),
    ...extra,
  });
  const milestones: Milestone[] = [milestone("starter", STARTER_CENTS)];
  if (essentials > 0) {
    milestones.push(milestone("one_month", essentials));
    milestones.push(milestone("target", essentials * months, { months }));
  }
  return {
    saved_cents: saved,
    essentials_cents: essentials,
    runway_tenths: runwayTenths(saved, essentials),
    target_months: months,
    monthly_plan_cents: plan,
    milestones,
  };
}
