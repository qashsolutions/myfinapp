/**
 * Port of stackd_rules/money.py. Integer cents, basis points, one rounding point.
 * All arithmetic is exact: BigInt for division, digit strings for parsing.
 */

import { RuleError } from "./errors.ts";
import { trimSpaces } from "./text.ts";

/** The largest whole number both engines hold exactly (2^53 − 1): past it, `too_large`. */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);

export function assertInt(value: unknown, code = "invalid_integer"): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new RuleError(code);
  if (Math.abs(value) > MAX_SAFE) throw new RuleError("too_large");
  return value;
}

/** A BigInt result as a Number once it is known to safeNumber; else `too_large`, as in Python. */
export function safeNumber(value: bigint): number {
  if (value > MAX_SAFE_BIG || value < -MAX_SAFE_BIG) throw new RuleError("too_large");
  return Number(value);
}

/**
 * The exact product of two integers, as Python's `a * b`: a BigInt, so no digit is lost when
 * the product passes 2^53 on its way into `roundDiv` or a comparison.
 */
export function mul(a: number, b: number): bigint {
  return BigInt(a) * BigInt(b);
}

/** `too_large` when any number in a rule's output is past MAX_SAFE (both registries). */
export function checkOutput(value: unknown): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) > MAX_SAFE) throw new RuleError("too_large");
  } else if (Array.isArray(value)) {
    for (const v of value) checkOutput(v);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) checkOutput(v);
  }
}

const UNSIGNED_DECIMAL = /^[0-9]*\.?[0-9]*$/;

/** Statement or form text -> cents. "$1,234.56" -> 123456; "(45.00)" and "99.99-" are negative. */
export function parseAmount(text: unknown): number {
  if (typeof text !== "string") throw new RuleError("invalid_amount");
  let s = trimSpaces(text).replaceAll(",", "").replaceAll("$", "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = trimSpaces(s.slice(1, -1));
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = trimSpaces(s.slice(0, -1));
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = trimSpaces(s.slice(1));
  } else if (s.startsWith("+")) {
    s = trimSpaces(s.slice(1));
  }
  if (!s || s === "." || !UNSIGNED_DECIMAL.test(s)) throw new RuleError("invalid_amount");
  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? "" : s.slice(dot + 1);
  const frac = fracPart.padEnd(2, "0");
  let cents = BigInt(intPart || "0") * 100n + BigInt(frac.slice(0, 2));
  const rest = frac.slice(2);
  if (rest.length > 0) {
    const first = rest[0] ?? "0";
    const tailNonZero = rest.slice(1).replace(/0+$/, "").length > 0;
    if (first > "5" || (first === "5" && tailNonZero)) cents += 1n;
    else if (first === "5" && cents % 2n === 1n) cents += 1n; // exact tie: round to even
  }
  const value = safeNumber(cents);
  return negative ? -value : value;
}

/**
 * numerator / denominator rounded half to even. The only rounding in the package. The
 * numerator may be an exact BigInt product (`mul`); the answer must safeNumber in MAX_SAFE.
 */
export function roundDiv(numerator: unknown, denominator: unknown): number {
  return safeNumber(roundDivExact(numerator, denominator));
}

/**
 * The same rounding as `roundDiv`, answered as a BigInt for a caller that must compare the result
 * with the limit itself (Python's big integers do this for free), such as a balance stalled
 * before it passes MAX_SAFE (invariant 10).
 */
export function roundDivExact(numerator: unknown, denominator: unknown): bigint {
  const n = typeof numerator === "bigint" ? numerator : BigInt(assertInt(numerator));
  const d0 = BigInt(assertInt(denominator));
  if (d0 === 0n) throw new RuleError("division_by_zero");
  const d = d0 < 0n ? -d0 : d0;
  const nn = d0 < 0n ? -n : n;
  let q = nn / d; // truncates toward zero
  let r = nn % d;
  if (r < 0n) {
    q -= 1n;
    r += d;
  }
  const twice = r * 2n;
  if (twice > d || (twice === d && q % 2n !== 0n)) q += 1n;
  return q;
}

/** bps/10000 of cents, half-even. */
export function pctOf(cents: unknown, bps: unknown): number {
  return roundDiv(mul(assertInt(cents), assertInt(bps)), 10000);
}

/** Split total by weights summing to 10000; the rounding remainder goes to one slot. */
export function allocate(
  totalCents: unknown,
  weightsBps: unknown,
  remainderTo: unknown = null,
): number[] {
  const total = assertInt(totalCents);
  if (!Array.isArray(weightsBps) || weightsBps.length === 0) {
    throw new RuleError("weights_must_sum_to_10000");
  }
  const weights = weightsBps.map((w) => assertInt(w));
  if (weights.reduce((a, b) => a + b, 0) !== 10000)
    throw new RuleError("weights_must_sum_to_10000");
  const index =
    remainderTo === null || remainderTo === undefined ? weights.length - 1 : assertInt(remainderTo);
  if (index < 0 || index >= weights.length) throw new RuleError("remainder_index_out_of_range");
  const parts = weights.map((w) => pctOf(total, w));
  const slot = parts[index] ?? 0;
  parts[index] = slot + (total - parts.reduce((a, b) => a + b, 0));
  return parts;
}

/** part / whole in basis points, half-even; null when whole is 0. Not capped at 100%. */
export function ratioBps(part: unknown, whole: unknown): number | null {
  assertInt(part);
  if (assertInt(whole) === 0) return null;
  return roundDiv(mul(part as number, 10000), whole);
}
