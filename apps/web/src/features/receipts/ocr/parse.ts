/**
 * Turns the text an OCR engine read off a receipt into suggestions for the entry form: the
 * merchant, the date and the total (fast-follow 6; docs/spec.md "Receipts": "pre-fills fields,
 * clearly marked for review; the user must confirm before saving").
 *
 * Pure: the same text and `asOf` give the same result, and nothing here does money maths. The
 * total stays text ("11.91") exactly as the user could have typed it, so the engine's
 * parse_amount turns it into cents when the entry is saved, like every other amount.
 */

export interface ReceiptSuggestion {
  merchant: string | null;
  /** ISO date, never after `asOf` */
  date: string | null;
  /** "11.91", as typed into the amount field */
  total: string | null;
  /** a line that says total, or the largest amount on the receipt when no line does */
  total_from: "total_line" | "largest" | null;
}

const AMOUNT = /(?<![0-9])(?:[$]\s?)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)[.,]([0-9]{2})(?![0-9])/g;
const TOTAL_LINE = /\b(?:grand\s+)?total\b|\bamount\s+due\b|\bbalance\s+due\b/i;
const NOT_A_TOTAL =
  /sub\s*-?\s*total|total\s+(?:savings?|saved|discount|items?|qty|tax)|you\s+saved/i;
/** Lines whose amount is not what was spent: change back, cash tendered, card details. */
const NOT_SPENT = /\bchange\b|\bcash\b|\btend/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMERIC_DATE = /(?<![0-9])([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{2}|[0-9]{4})(?![0-9])/;
const ISO_DATE = /(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/;
const MONTH_FIRST =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?,?\s+([0-9]{4})\b/i;
const DAY_FIRST =
  /\b([0-9]{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+([0-9]{4})\b/i;
const NOT_A_MERCHANT =
  /^(?:receipt|invoice|welcome|thank|order|store\s*#|tel|phone|fax|www\.|https?:|cashier|register|customer|copy|date|time)\b|total|tax\b|visa|mastercard|amex|discover|debit|credit|cash|change|approved|\.com\b/i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** Every amount on a line, as "123.45" strings in order of appearance. */
export function amountsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    const whole = (m[1] as string).replace(/,/g, "");
    out.push(`${whole}.${m[2]}`);
  }
  return out;
}

/** Compares two "123.45" strings without arithmetic: wider whole part wins, then text order. */
function largerAmount(a: string, b: string): string {
  const [aw, ac] = a.split(".") as [string, string];
  const [bw, bc] = b.split(".") as [string, string];
  const width = Math.max(aw.length, bw.length);
  const ak = `${aw.padStart(width, "0")}${ac}`;
  const bk = `${bw.padStart(width, "0")}${bc}`;
  return bk > ak ? b : a;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isoOf(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2099) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateIn(line: string): string | null {
  const iso = ISO_DATE.exec(line);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = NUMERIC_DATE.exec(line);
  if (numeric) {
    let first = Number(numeric[1]);
    let second = Number(numeric[2]);
    const yearText = numeric[3] as string;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    // Month first (US receipts); day first when the first number cannot be a month.
    if (first > 12 && second <= 12) [first, second] = [second, first];
    return isoOf(year, first, second);
  }
  const monthFirst = MONTH_FIRST.exec(line);
  if (monthFirst)
    return isoOf(
      Number(monthFirst[3]),
      MONTHS.indexOf((monthFirst[1] as string).slice(0, 3).toLowerCase()) + 1,
      Number(monthFirst[2]),
    );
  const dayFirst = DAY_FIRST.exec(line);
  if (dayFirst)
    return isoOf(
      Number(dayFirst[3]),
      MONTHS.indexOf((dayFirst[2] as string).slice(0, 3).toLowerCase()) + 1,
      Number(dayFirst[1]),
    );
  return null;
}

/** "CORNER MARKET" reads better as "Corner Market"; mixed case is left as printed. */
function tidyName(line: string): string {
  let name = line;
  if (name.length > 40) {
    const cut = name.lastIndexOf(" ", 40);
    name = name.slice(0, cut > 0 ? cut : 40).trim();
  }
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(" ")
    .map((word) => (word ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function merchantIn(rows: string[]): string | null {
  for (const line of rows.slice(0, 6)) {
    const letters = (line.match(/[A-Za-z]/g) ?? []).length;
    const digits = (line.match(/[0-9]/g) ?? []).length;
    if (letters < 3 || digits > 2) continue;
    if (NOT_A_MERCHANT.test(line)) continue;
    return tidyName(line);
  }
  return null;
}

function totalIn(rows: string[]): Pick<ReceiptSuggestion, "total" | "total_from"> {
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i] as string;
    if (!TOTAL_LINE.test(line) || NOT_A_TOTAL.test(line)) continue;
    const own = amountsIn(line);
    if (own.length > 0) return { total: own[own.length - 1] as string, total_from: "total_line" };
    // The amount may sit on the next line when the engine split the columns.
    const next = rows[i + 1] ? amountsIn(rows[i + 1] as string) : [];
    if (next.length > 0 && !TOTAL_LINE.test(rows[i + 1] as string))
      return { total: next[next.length - 1] as string, total_from: "total_line" };
  }
  let largest: string | null = null;
  for (const line of rows) {
    if (NOT_SPENT.test(line)) continue;
    for (const amount of amountsIn(line))
      largest = largest ? largerAmount(largest, amount) : amount;
  }
  return largest ? { total: largest, total_from: "largest" } : { total: null, total_from: null };
}

export function parseReceiptText(text: string, asOf: string): ReceiptSuggestion {
  const rows = lines(text);
  let date: string | null = null;
  for (const line of rows) {
    const found = dateIn(line);
    if (found && found <= asOf) {
      date = found;
      break;
    }
  }
  return { merchant: merchantIn(rows), date, ...totalIn(rows) };
}
