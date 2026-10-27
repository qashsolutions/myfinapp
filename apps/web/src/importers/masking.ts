/** Account and card numbers never reach storage in full (docs/spec.md "Statement import"). */

const LONG_NUMBER = /\d(?:[ -]?\d){7,}/g;

/** "PAYMENT 4111 1111 1111 1234" → "PAYMENT ••1234". Runs of 8+ digits only; dates and amounts stay. */
export function maskNumbers(text: string): string {
  return text.replace(LONG_NUMBER, (m) => `••${m.replace(/\D/g, "").slice(-4)}`);
}

/** The last four digits of an account id, or null when there are fewer than four. */
export function last4(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}
