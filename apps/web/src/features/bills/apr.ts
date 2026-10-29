/**
 * Card and debt rates the person types (owner decision, October 29, 2026): suggestions 19.99% /
 * 24.99% / 29.99% plus their own, 0% to 40% ("APR will never be 100%"). One range for a linked
 * card's own APR, a debt added by hand (cards and loans alike: personal, car and student loans
 * sit inside it too) and so the plan never takes a rate the person couldn't mean.
 */

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

/** A message when `bps` is outside 0% to 40%, else null. */
export function aprProblem(bps: number): string | null {
  return bps < 0 || bps > APR_MAX_BPS ? APR_OUT_OF_RANGE : null;
}
