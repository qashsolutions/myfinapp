/**
 * PDF statement templates (docs/spec.md "Statement import": fixed per-institution templates for
 * a launch list of banks; everyone else gets "download a CSV instead"). A template says how to
 * recognise a bank's statement and how to read its lines; the generic one reads the common
 * "date  description  amount  [balance]" layout and is tried last.
 *
 * The launch bank list is an owner decision (`[launch bank list]`): add a template per
 * institution here with a fixture under tests/fixtures, never a guess at a layout.
 */

import type { MappedRow } from "../csv.ts";
import { last4, maskNumbers } from "../masking.ts";

export interface PdfStatement {
  template_key: string;
  institution: string | null;
  /** The account's last four and, from the header's words, its likely type (null = unsure). */
  account: { last4: string | null; type: "checking" | "savings" | "credit_card" | null };
  rows: MappedRow[];
  ledger: { cents: number; as_of: string } | null;
  period: { start: string | null; end: string | null };
  skipped: number;
  /**
   * Do the rows add up (October 22, 2026)? The last row's running balance, or the opening balance
   * plus every row, against the statement's ending balance; null when the statement doesn't
   * print enough to tell. A PDF read wrongly then says so instead of importing quietly.
   */
  reconciles: boolean | null;
}

export interface PdfTemplate {
  key: string;
  institution: string | null;
  /** Does this statement look like the institution's? Header lines only. */
  matches: (lines: string[]) => boolean;
  parse: (lines: string[], parseAmount: (text: string) => Promise<number>) => Promise<PdfStatement>;
}

const US_DATE = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/;
const MONEY = /^\(?-?\$?[\d,]*\d\.\d{2}\)?-?(?:\s?(?:CR|DR))?$/i;
const PERIOD =
  /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(?:-|–|to|through)\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i;
const ENDING = /(?:ending|closing|new)\s+balance[^\d(-]*(\(?-?\$?[\d,]*\d\.\d{2}\)?-?)/i;
const OPENING =
  /(?:beginning|opening|previous|starting)\s+balance[^\d(-]*(\(?-?\$?[\d,]*\d\.\d{2}\)?-?)/i;
const ACCOUNT = /(?:account|acct)[^\d]{0,24}?(?:[*xX•]{2,}|ending in|ending)\s*(\d{4})\b/i;

function isoDate(
  month: string,
  day: string,
  year: string | null,
  fallbackYear: number | null,
): string | null {
  let y = year ? Number(year.length === 2 ? `20${year}` : year) : fallbackYear;
  const m = Number(month);
  const d = Number(day);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  y = date.getUTCFullYear();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseIso(text: string, fallbackYear: number | null): string | null {
  const m = US_DATE.exec(text);
  return m ? isoDate(m[1] ?? "", m[2] ?? "", m[3] ?? null, fallbackYear) : null;
}

/** "(54.10)", "54.10-", "-54.10", "54.10 CR": a signed amount for the rules engine's parser. */
function normaliseMoney(text: string): string {
  let t = text.trim().replace(/\$/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith("-")) {
    negative = true;
    t = t.slice(0, -1);
  }
  if (/\s?DR$/i.test(t)) {
    negative = true;
    t = t.replace(/\s?DR$/i, "");
  }
  t = t.replace(/\s?CR$/i, "");
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  }
  return `${negative ? "-" : ""}${t.replace(/,/g, "")}`;
}

/**
 * The generic layout: every line that starts with a date and ends with one or two amounts is a
 * transaction; with a running balance the sign comes from the balance change (bank PDFs often
 * print withdrawals unsigned), otherwise from the printed sign.
 */
/** "Savings", "Checking", or a card word in the statement's header; null when it says none. */
export function typeFromHeader(header: string): "checking" | "savings" | "credit_card" | null {
  if (/credit card|\bvisa\b|mastercard|amex|discover card|card account/i.test(header))
    return "credit_card";
  if (/savings|money market/i.test(header)) return "savings";
  if (/checking/i.test(header)) return "checking";
  return null;
}

export const GENERIC: PdfTemplate = {
  key: "generic_lines",
  institution: null,
  matches: () => true,
  async parse(lines, parseAmount) {
    const header = lines.slice(0, 40).join("\n");
    const periodMatch = PERIOD.exec(header);
    const period = {
      start: periodMatch ? parseIso(periodMatch[1] ?? "", null) : null,
      end: periodMatch ? parseIso(periodMatch[2] ?? "", null) : null,
    };
    const yearGuess = period.end ? Number(period.end.slice(0, 4)) : null;
    const endMonth = period.end ? Number(period.end.slice(5, 7)) : null;
    const accountMatch = ACCOUNT.exec(header);
    const institution = lines[0]?.trim() || null;
    const rows: MappedRow[] = [];
    let skipped = 0;
    // The opening balance, when printed, settles the first row's sign as later rows' are.
    const openingMatch = OPENING.exec(lines.join("\n"));
    let opening: number | null = null;
    try {
      opening = openingMatch ? await parseAmount(normaliseMoney(openingMatch[1] ?? "")) : null;
    } catch {
      opening = null;
    }
    let previousBalance: number | null = opening;
    for (let i = 0; i < lines.length; i++) {
      const parts = (lines[i] ?? "").split(" ");
      if (parts.length < 3 || !US_DATE.test(parts[0] ?? "")) continue;
      // "20.00 CR" prints the credit marker as its own word; glue it to the amount.
      if (/^(?:CR|DR)$/i.test(parts[parts.length - 1] ?? "") && parts.length > 3)
        parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]} ${parts[parts.length - 1]}`);
      const tail: string[] = [];
      while (parts.length > 1 && MONEY.test(parts[parts.length - 1] ?? "") && tail.length < 2)
        tail.unshift(parts.pop() ?? "");
      if (tail.length === 0) continue;
      const [dateText, ...descriptionParts] = parts;
      let year = yearGuess;
      const monthOfRow = Number((dateText ?? "").split(/[/-]/)[0]);
      if (year && endMonth && monthOfRow > endMonth) year -= 1; // a December line on a January statement
      const date = parseIso(dateText ?? "", year);
      if (!date) {
        skipped += 1;
        continue;
      }
      try {
        let amount = await parseAmount(normaliseMoney(tail[0] ?? ""));
        let balance: number | null = null;
        if (tail.length === 2) {
          balance = await parseAmount(normaliseMoney(tail[1] ?? ""));
          if (previousBalance !== null) amount = balance - previousBalance;
          previousBalance = balance;
        }
        rows.push({
          row: i + 1,
          date,
          description: maskNumbers(descriptionParts.join(" ").trim()),
          amount_cents: amount,
          balance_cents: balance,
        });
      } catch {
        skipped += 1;
      }
    }
    const endingMatch = ENDING.exec(lines.join("\n"));
    let ledger: PdfStatement["ledger"] = null;
    if (endingMatch && (period.end || rows.length)) {
      try {
        ledger = {
          cents: await parseAmount(normaliseMoney(endingMatch[1] ?? "")),
          as_of: period.end ?? (rows[rows.length - 1]?.date as string),
        };
      } catch {
        ledger = null;
      }
    }
    return {
      template_key: GENERIC.key,
      institution,
      account: {
        last4: accountMatch ? last4(accountMatch[1]) : null,
        type: typeFromHeader(header),
      },
      rows,
      ledger,
      period,
      skipped,
      reconciles: reconcile(rows, opening, ledger),
    };
  },
};

function reconcile(
  rows: MappedRow[],
  opening: number | null,
  ledger: PdfStatement["ledger"],
): boolean | null {
  if (!ledger || rows.length === 0) return null;
  const last = rows[rows.length - 1]?.balance_cents ?? null;
  if (last !== null) return last === ledger.cents;
  if (opening === null) return null;
  return opening + rows.reduce((sum, r) => sum + r.amount_cents, 0) === ledger.cents;
}

/** Per-institution templates, tried before the generic one. The launch list is pending. */
export const TEMPLATES: PdfTemplate[] = [];

export class PdfError extends Error {
  constructor(public readonly code: "no_text" | "unsupported_layout") {
    super(code);
    this.name = "PdfError";
  }
}

export async function parsePdfLines(
  lines: string[],
  parseAmount: (text: string) => Promise<number>,
): Promise<PdfStatement> {
  if (lines.length === 0) throw new PdfError("no_text");
  const header = lines.slice(0, 40);
  const template = TEMPLATES.find((t) => t.matches(header)) ?? GENERIC;
  const statement = await template.parse(lines, parseAmount);
  if (statement.rows.length === 0) throw new PdfError("unsupported_layout");
  return statement;
}
