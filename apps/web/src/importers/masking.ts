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

/** A date written with digits, which a file name keeps: 2026-10-31, 20261031, 10-31-2026. */
const DATE_LIKE = [
  /^(19|20)\d{2}[-\s]?(0[1-9]|1[0-2])[-\s]?(0[1-9]|[12]\d|3[01])$/,
  /^(0?[1-9]|1[0-2])[-\s](0?[1-9]|[12]\d|3[01])[-\s](19|20)\d{2}$/,
];

/**
 * A file's name as Qash shows and keeps it (owner decision, November 16, 2026: mask every
 * account number): any run of five or more digits, spaces or dashes between them counted
 * together ("4111 1111 1111 1173", "250044484"), becomes ••last four, except a date. Four
 * digits or fewer stay (a year, or the last four a statement already shows).
 */
export function maskFileName(name: string): string {
  return name.replace(/\d+(?:[-\s]\d+)*/g, (run) => {
    if (DATE_LIKE.some((re) => re.test(run))) return run;
    const digits = run.replace(/\D/g, "");
    return digits.length >= 5 ? `••${digits.slice(-4)}` : run;
  });
}
