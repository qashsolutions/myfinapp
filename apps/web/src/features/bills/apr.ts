/**
 * Card and debt rates the person types (owner decision, October 29, 2026): suggestions 19.99% /
 * 24.99% / 29.99% plus their own, 0% to 40% ("APR will never be 100%"). One range for a linked
 * card's own APR, a debt added by hand (cards and loans alike: personal, car and student loans
 * sit inside it too) and so the plan never takes a rate the person couldn't mean.
 */

import { debtGroupFor } from "../networth/useNetWorth.ts";

/** The highest rate taken, in basis points (40%). */
export const APR_MAX_BPS = 40_00;

export const APR_OUT_OF_RANGE = "Card rates are between 0% and 40%.";

/** The suggested rates, as the percent text the box takes. */
export const APR_SUGGESTIONS: Array<[string, string]> = [
  ["19.99", "19.99%"],
  ["24.99", "24.99%"],
  ["29.99", "29.99%"],
];

/** A rate typed as "24.99" or "24.99%": the text, or a message. Range is checked in bps. */
export function readAprText(text: string): { value: string } | { error: string } {
  const t = text.trim().replace(/%$/, "").trim();
  return /^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(t)
    ? { value: t }
    : { error: "Enter a rate like 24.99." };
}

/**
 * A debt added by hand (owner decision, October 29, 2026): a card keeps 0% to 40%; any other
 * debt (a loan, a payday loan) takes 0% to 400%, and above 40% the sheet asks once whether
 * the rate is right before saving, so a typo is caught but a real payday loan fits.
 */
export type DebtKind = "card" | "loan" | "other";

export const DEBT_KINDS: Array<[DebtKind, string]> = [
  ["card", "Card"],
  ["loan", "Loan"],
  ["other", "Other"],
];

/** The highest rate any other debt takes (400%). */
export const LOAN_APR_MAX_BPS = 400_00;
export const LOAN_APR_OUT_OF_RANGE = "Rates are between 0% and 400%.";
export const HIGH_RATE_QUESTION = "That's a very high rate. Is it right?";

/** The kind a label suggests ("Visa" a card, "Car loan" a loan) until the person picks one. */
export function kindFromLabel(label: string): DebtKind {
  // Net worth's own reading of a debt's name, so the two never disagree.
  const group = debtGroupFor(label);
  if (group === "card") return "card";
  return group === "other_debt" ? "other" : "loan";
}

/** What a typed rate needs for this kind of debt: a refusal, one question, or nothing. */
export function debtAprCheck(
  kind: DebtKind,
  bps: number,
): { error: string } | { confirm: string } | null {
  if (kind === "card") {
    const problem = aprProblem(bps);
    return problem ? { error: problem } : null;
  }
  if (bps < 0 || bps > LOAN_APR_MAX_BPS) return { error: LOAN_APR_OUT_OF_RANGE };
  return bps > APR_MAX_BPS ? { confirm: HIGH_RATE_QUESTION } : null;
}

/** A message when `bps` is outside 0% to 40%, else null. */
export function aprProblem(bps: number): string | null {
  return bps < 0 || bps > APR_MAX_BPS ? APR_OUT_OF_RANGE : null;
}
