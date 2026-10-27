/**
 * Port of stackd_rules/growth.py: the Later projection, exact, with r = rate ÷ 12 as a fraction
 * of BigInts, rounded half-even once at the end. (growth.compound was removed October 27, 2026.)
 */

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
