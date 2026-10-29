/**
 * Port of stackd_rules/growth.py: the Later projection, exact, with r = rate ÷ 12 as a fraction
 * of BigInts, rounded half-even once at the end. (growth.compound was removed October 27, 2026.)
 */

import { addMonths, daysUntil, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";

export const MAX_RATE_BPS = 50000;
const MONTHS_BPS = 120000n;
/** The most cents both engines count exactly (2^53 − 1): above it, `too_large` (October 27, 2026). */
export const MAX_CENTS = 9007199254740991n;

/** Each amount as a Number, once it is known to fit; else `too_large`, as in Python. */
function fit(cents: bigint): number {
  if (cents > MAX_CENTS) throw new RuleError("too_large");
  return Number(cents);
}

/** numerator / denominator (both > 0 or numerator >= 0) rounded half to even, as a BigInt. */
function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  let q = numerator / denominator;
  let r = numerator % denominator;
  if (r < 0n) {
    q -= 1n;
    r += denominator;
  }
  const twice = r * 2n;
  if (twice > denominator || (twice === denominator && q % 2n !== 0n)) q += 1n;
  return q;
}

export const MIN_AGE = 16;
export const MAX_AGE = 100;
const MAX_RATES = 3;

/** An exact non-negative rational n / d, both BigInt. */
type Q = { n: bigint; d: bigint };

export interface ProjectionPoint {
  age: number;
  contributed_cents: number;
  balances_cents: number[];
}

export interface Projection {
  years: number;
  points: ProjectionPoint[];
  at_retirement_cents: number[];
  middle_index: number;
  target_cents: number;
  reaches_target: boolean | null;
  monthly_needed_cents: number | null;
}

/**
 * Port of growth.projection: at monthly rate r = rate ÷ M (M = 120000), (1 + r)^m = (M + rate)^m ÷
 * M^m, so the balance S × g + P × (g − 1) ÷ r is
 * (S × (M + rate)^m × rate + P × M × ((M + rate)^m − M^m)) ÷ (rate × M^m), rounded half-even.
 */
function balanceAt(start: bigint, monthly: bigint, rate: bigint, months: number): bigint {
  if (rate === 0n) return start + monthly * BigInt(months);
  const m = MONTHS_BPS;
  const up = (m + rate) ** BigInt(months);
  const base = m ** BigInt(months);
  const numerator = start * up * rate + monthly * m * (up - base);
  return roundHalfEven(numerator, rate * base);
}

/** round((G − S × g) × r ÷ (g − 1)) at least 0; r = 0 → round((G − S) ÷ months). */
function neededAt(target: bigint, start: bigint, rate: bigint, months: number): bigint {
  let q: Q;
  if (rate === 0n) {
    q = { n: target - start, d: BigInt(months) };
  } else {
    const m = MONTHS_BPS;
    const up = (m + rate) ** BigInt(months);
    const base = m ** BigInt(months);
    // (G − S × up/base) × (rate/m) ÷ ((up − base)/base) = (G × base − S × up) × rate ÷ (m × (up − base))
    q = { n: (target * base - start * up) * rate, d: m * (up - base) };
  }
  if (q.n <= 0n) return 0n;
  return roundHalfEven(q.n, q.d);
}

export function projection(
  ageNow: unknown,
  retireAge: unknown,
  startCents: unknown,
  monthlyCents: unknown,
  ratesBps: unknown,
  targetCents: unknown,
): Projection {
  const now = assertInt(ageNow);
  const retire = assertInt(retireAge);
  const start = assertInt(startCents);
  const monthly = assertInt(monthlyCents);
  const target = assertInt(targetCents);
  if (now < MIN_AGE || now >= MAX_AGE || retire <= now || retire > MAX_AGE)
    throw new RuleError("invalid_age");
  if (start < 0 || monthly < 0 || target < 0) throw new RuleError("invalid_amount");
  if (!Array.isArray(ratesBps) || ratesBps.length < 1 || ratesBps.length > MAX_RATES)
    throw new RuleError("invalid_rates");
  const rates = ratesBps.map((r) => assertInt(r));
  if (rates.some((r) => r < 0 || r > MAX_RATE_BPS)) throw new RuleError("invalid_rate");
  if (rates.some((r, i) => i > 0 && r < (rates[i - 1] as number)))
    throw new RuleError("invalid_rates");
  for (const cents of [start, monthly, target]) fit(BigInt(cents));
  const years = retire - now;
  const s = BigInt(start);
  const p = BigInt(monthly);
  const points: ProjectionPoint[] = [];
  for (let k = 0; k <= years; k++) {
    const months = 12 * k;
    points.push({
      age: now + k,
      contributed_cents: fit(s + p * BigInt(months)),
      balances_cents: rates.map((r) => fit(balanceAt(s, p, BigInt(r), months))),
    });
  }
  const middle = Math.floor((rates.length - 1) / 2);
  const atRetirement = (points[points.length - 1] as ProjectionPoint).balances_cents;
  let reaches: boolean | null = null;
  let needed: number | null = null;
  if (target > 0) {
    reaches = (atRetirement[middle] as number) >= target;
    needed = fit(neededAt(BigInt(target), s, BigInt(rates[middle] as number), 12 * years));
  }
  return {
    years,
    points,
    at_retirement_cents: atRetirement,
    middle_index: middle,
    target_cents: target,
    reaches_target: reaches,
    monthly_needed_cents: needed,
  };
}

// Goals that grow (October 28, 2026): 65 years at most (owner sign-off, October 29, 2026).
const MAX_GOAL_MONTHS = 780;

/** Calendar months from start's month to end's month (days ignored), as in Python. */
export function monthsBetween(start: unknown, end: unknown): number {
  const a = parseDate(start);
  const b = parseDate(end);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/** a after b by day, parsing a first, as Python's `parse_date(a) > parse_date(b)`. */
function after(a: unknown, b: unknown): boolean {
  const first = parseDate(a);
  const second = parseDate(b);
  return daysUntil(second, first) > 0;
}

export interface GoalPlan {
  months: number;
  cost_months: number;
  future_cost_cents: number;
  saved_grows_to_cents: number;
  monthly_needed_cents: number;
  already_enough: boolean;
}

/**
 * Port of growth.goal_plan. With M = 120000, F = T × (M + c)^m ÷ M^m and g = (M + r)^n ÷ M^n, so
 * P = (T (M + c)^m M^n − S (M + r)^n M^m) × r ÷ (M^(m + 1) × ((M + r)^n − M^n)); r = 0 →
 * (T (M + c)^m − S M^m) ÷ (n M^m). Each output rounded half-even once, P at least 0.
 */
export function goalPlan(
  todayCostCents: unknown,
  costRiseBps: unknown,
  returnBps: unknown,
  savedCents: unknown,
  asOf: unknown,
  targetDate: unknown,
  pricedOn: unknown = null,
): GoalPlan {
  const today = assertInt(todayCostCents);
  const rise = assertInt(costRiseBps);
  const rate = assertInt(returnBps);
  const saved = assertInt(savedCents);
  if (today <= 0 || saved < 0) throw new RuleError("invalid_amount");
  if (rise < 0 || rise > MAX_RATE_BPS || rate < 0 || rate > MAX_RATE_BPS)
    throw new RuleError("invalid_rate");
  const priced = pricedOn === null || pricedOn === undefined ? asOf : pricedOn;
  if (after(priced, asOf)) throw new RuleError("invalid_date");
  if (after(asOf, targetDate)) throw new RuleError("deadline_in_past");
  const months = monthsBetween(asOf, targetDate);
  if (months === 0) throw new RuleError("too_soon");
  const costMonths = monthsBetween(priced, targetDate);
  if (costMonths > MAX_GOAL_MONTHS) throw new RuleError("too_far");
  const M = MONTHS_BPS;
  const T = BigInt(today);
  const S = BigInt(saved);
  const r = BigInt(rate);
  const costUp = (M + BigInt(rise)) ** BigInt(costMonths);
  const costBase = M ** BigInt(costMonths);
  const up = (M + r) ** BigInt(months);
  const base = M ** BigInt(months);
  const future = roundHalfEven(T * costUp, costBase);
  const grows = roundHalfEven(S * up, base);
  let numerator: bigint;
  let denominator: bigint;
  if (r === 0n) {
    numerator = T * costUp - S * costBase;
    denominator = BigInt(months) * costBase;
  } else {
    numerator = (T * costUp * base - S * up * costBase) * r;
    denominator = costBase * M * (up - base);
  }
  const needed = numerator <= 0n ? 0n : roundHalfEven(numerator, denominator);
  return {
    months,
    cost_months: costMonths,
    future_cost_cents: fit(future),
    saved_grows_to_cents: fit(grows),
    monthly_needed_cents: fit(needed),
    already_enough: S * up * costBase >= T * costUp * base,
  };
}

export interface GoalReachPoint {
  month: string; // YYYY-MM
  months: number;
  cost_cents: number;
  saved_cents: number;
}

export interface GoalReach {
  months: number;
  target_cost_cents: number;
  at_target_cents: number;
  short_by_cents: number;
  reaches_by_target: boolean;
  reach_months: number | null;
  reach_month: string | null;
  points: GoalReachPoint[];
}

function monthOf(first: { y: number; m: number; d: number }, k: number): string {
  const day = addMonths(first, k);
  return `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}`;
}

/**
 * Port of growth.goal_reach: with V = (M + c)^q, W = M^q (the cost), U = (M + r)^k, B = M^k
 * (the savings), month k counts as reached when goal_plan's amount for k months, rounded half
 * to even, is at most P (k = 0: S W >= T V); the first such k within 65 years of priced_on is
 * the reach month. Points each 12 months and at the target: cost T V / W and savings
 * (S U r + P M (U - B)) / (r B), or S + P k with r = 0.
 */
export function goalReach(
  todayCostCents: unknown,
  costRiseBps: unknown,
  returnBps: unknown,
  savedCents: unknown,
  monthlyCents: unknown,
  asOf: unknown,
  targetDate: unknown,
  pricedOn: unknown = null,
): GoalReach {
  const plan = goalPlan(
    todayCostCents,
    costRiseBps,
    returnBps,
    savedCents,
    asOf,
    targetDate,
    pricedOn,
  );
  const monthly = assertInt(monthlyCents);
  if (monthly < 0) throw new RuleError("invalid_amount");
  fit(BigInt(monthly));
  const T = BigInt(assertInt(todayCostCents));
  const S = BigInt(assertInt(savedCents));
  const c = BigInt(assertInt(costRiseBps));
  const r = BigInt(assertInt(returnBps));
  const P = BigInt(monthly);
  const priced = pricedOn === null || pricedOn === undefined ? asOf : pricedOn;
  const offset = monthsBetween(priced, asOf);
  const n = plan.months;
  const M = MONTHS_BPS;
  let V = (M + c) ** BigInt(offset);
  let W = M ** BigInt(offset);
  let U = 1n;
  let B = 1n;
  const first = { ...parseDate(asOf), d: 1 };
  let reach: number | null = null;
  let byTarget = false;
  const points: GoalReachPoint[] = [];
  let atTarget = 0n;
  let short = 0n;
  for (let k = 0; k <= MAX_GOAL_MONTHS - offset; k += 1) {
    if (k > 0) {
      V *= M + c;
      W *= M;
      U *= M + r;
      B *= M;
    }
    if (reach === null || k === n) {
      let hit: boolean;
      if (k === 0) {
        hit = S * W >= T * V;
      } else {
        let num: bigint;
        let den: bigint;
        if (r === 0n) {
          num = T * V - S * W;
          den = BigInt(k) * W;
        } else {
          num = (T * V * B - S * U * W) * r;
          den = W * M * (U - B);
        }
        hit = (num <= 0n ? 0n : roundHalfEven(num, den)) <= P;
      }
      if (hit && reach === null) reach = k;
      if (k === n) byTarget = hit;
    }
    if (k <= n && (k % 12 === 0 || k === n)) {
      // The cost and the savings as exact fractions, each rounded once.
      const costN = T * V;
      const costD = W;
      const savedN = r === 0n ? S + P * BigInt(k) : S * U * r + P * M * (U - B);
      const savedD = r === 0n ? 1n : r * B;
      points.push({
        month: monthOf(first, k),
        months: k,
        cost_cents: fit(roundHalfEven(costN, costD)),
        saved_cents: fit(roundHalfEven(savedN, savedD)),
      });
      if (k === n) {
        atTarget = roundHalfEven(savedN, savedD);
        const gapN = costN * savedD - savedN * costD;
        short = gapN <= 0n ? 0n : roundHalfEven(gapN, costD * savedD);
      }
    }
    if (k >= n && reach !== null) break;
  }
  return {
    months: n,
    target_cost_cents: plan.future_cost_cents,
    at_target_cents: fit(atTarget),
    short_by_cents: byTarget ? 0 : fit(short),
    reaches_by_target: byTarget,
    reach_months: reach,
    reach_month: reach === null ? null : monthOf(first, reach),
    points,
  };
}

export interface GoalPace {
  months_in: number;
  expected_cents: number;
  status: "ahead" | "on_track" | "behind";
}

/** Port of growth.goal_pace: expected = P × (months from the start's month + 1). */
export function goalPace(
  planMonthlyCents: unknown,
  depositedCents: unknown,
  startDate: unknown,
  asOf: unknown,
): GoalPace {
  const plan = assertInt(planMonthlyCents);
  const deposited = BigInt(assertInt(depositedCents));
  if (plan < 0) throw new RuleError("invalid_amount");
  if (after(startDate, asOf)) throw new RuleError("invalid_date");
  const monthsIn = monthsBetween(startDate, asOf) + 1;
  const P = BigInt(plan);
  const expected = P * BigInt(monthsIn);
  const expectedCents = fit(expected);
  let status: GoalPace["status"] = "on_track";
  if (deposited >= expected + P) status = "ahead";
  else if (deposited < expected - P) status = "behind";
  return { months_in: monthsIn, expected_cents: expectedCents, status };
}
