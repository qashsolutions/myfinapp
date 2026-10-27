/**
 * Port of stackd_rules/money.py. Integer cents, basis points, one rounding point.
 * All arithmetic is exact: BigInt for division, digit strings for parsing.
 */

import { RuleError } from "./errors.ts";

export function assertInt(value: unknown, code = "invalid_integer"): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new RuleError(code);
  return value;
}

const UNSIGNED_DECIMAL = /^[0-9]*\.?[0-9]*$/;

/** Statement or form text -> cents. "$1,234.56" -> 123456; "(45.00)" and "99.99-" are negative. */
export function parseAmount(text: unknown): number {
  if (typeof text !== "string") throw new RuleError("invalid_amount");
  let s = text.trim().replaceAll(",", "").replaceAll("$", "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
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
  const value = Number(cents);
  return negative ? -value : value;
}

/** numerator / denominator rounded half to even. The only rounding in the package. */
export function roundDiv(numerator: unknown, denominator: unknown): number {
  const n = BigInt(assertInt(numerator));
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
  return Number(q);
}

/** bps/10000 of cents, half-even. */
export function pctOf(cents: unknown, bps: unknown): number {
  return roundDiv(assertInt(cents) * assertInt(bps), 10000);
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
  return roundDiv((part as number) * 10000, whole);
}
