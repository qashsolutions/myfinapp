/**
 * Documents that hold a total, not transactions (owner decision, November 16, 2026): a
 * brokerage, IRA, 401(k) or HSA positions page or statement, and a loan or mortgage statement.
 * Read on the device with fixed words, never a model: one total, the date it is from, a name made
 * from the kind of account ("Rollover IRA", "Mortgage") and the Net worth kind it belongs to.
 * Account numbers and holdings are never kept; the person confirms before anything is saved.
 */

export interface DocumentTotal {
  kind: "asset" | "debt";
  /** A Net worth group (features/networth ASSET_GROUPS / DEBT_GROUPS). */
  group: string;
  label: string;
  cents: number;
  /** YYYY-MM-DD the document says the total is from, or null when it doesn't say. */
  as_of: string | null;
  doc: "investments" | "loan";
  /** The account number's last four, shown so the person knows which account; never kept. */
  last4: string | null;
  /** The words the kind was read from ("Rollover IRA"), or null when none matched. */
  kind_from: string | null;
}

/** Words of a positions page or brokerage statement. */
const HOLDINGS_WORDS = [
  "positions",
  "holdings",
  "cost basis",
  "quantity",
  "symbol",
  "market value",
  "unrealized",
  "% of account",
  "gain/loss",
];

export function looksLikeHoldings(lines: string[]): boolean {
  const text = lines.slice(0, 120).join(" ").toLowerCase();
  return HOLDINGS_WORDS.filter((w) => text.includes(w)).length >= 3;
}

/** The account kinds a document names, most specific first, with their Net worth group. */
const ACCOUNT_KINDS: [RegExp, string, string][] = [
  [/\brollover ira\b/i, "Rollover IRA", "retirement"],
  [/\broth ira\b/i, "Roth IRA", "retirement"],
  [/\btraditional ira\b/i, "Traditional IRA", "retirement"],
  [/\bsep[- ]ira\b/i, "SEP IRA", "retirement"],
  [/\bsimple ira\b/i, "SIMPLE IRA", "retirement"],
  [/\b401\s?\(?k\)?/i, "401(k)", "retirement"],
  [/\b403\s?\(?b\)?/i, "403(b)", "retirement"],
  [/\b457\s?\(?b\)?/i, "457(b)", "retirement"],
  [/\bira\b/i, "IRA", "retirement"],
  [/\bhealth savings account\b|\bhsa\b/i, "HSA", "retirement"],
  [/\bbrokerage\b/i, "Brokerage", "investments"],
  [/\bindividual\b/i, "Investments", "investments"],
];

const LOAN_KINDS: [RegExp, string, string][] = [
  [/\bmortgage\b|\bhome loan\b|\bheloc\b/i, "Mortgage", "mortgage"],
  [/\bauto loan\b|\bcar loan\b|\bvehicle loan\b/i, "Car loan", "auto_loan"],
  [/\bstudent loan\b/i, "Student loan", "student_loan"],
  [/\bpersonal loan\b/i, "Personal loan", "personal_loan"],
  [/\bloan\b/i, "Loan", "personal_loan"],
];

/** The phrases a total follows, best first. */
const INVESTMENT_TOTALS = [
  "account total",
  "total account value",
  "net account value",
  "total portfolio value",
  "portfolio value",
  "ending account value",
  "total market value",
  "account value",
  "total value",
];
const LOAN_TOTALS = [
  "unpaid principal balance",
  "outstanding principal balance",
  "principal balance",
  "outstanding principal",
  "loan balance",
  "current balance",
];

/** Words that make a document a loan statement: one of these and "principal". */
const LOAN_WORDS = /\bmortgage\b|\bloan\b|\bheloc\b/i;

const MONEY = /\(?-?\$\s?[\d,]*\d(?:\.\d{2})?\)?|\(?-?[\d,]*\d\.\d{2}\)?/;

/** The first amount after `phrase` on its line, or on the next line when the line has none. */
function amountAfter(lines: string[], phrase: string): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const at = line.toLowerCase().indexOf(phrase);
    if (at < 0) continue;
    const rest = line.slice(at + phrase.length);
    const here = MONEY.exec(rest);
    if (here) return here[0];
    const next = MONEY.exec(lines[i + 1] ?? "");
    if (next) return next[0];
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");

function validIso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A date in the forms statements print: Sep-03-2026, Sep 3, 2026, September 3 2026, 09/03/2026. */
export function readDate(text: string): string | null {
  const named = /\b([A-Za-z]{3,9})[\s.-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})\b/.exec(text);
  if (named) {
    const m = MONTHS[(named[1] ?? "").slice(0, 3).toLowerCase()];
    if (m) return validIso(Number(named[3]), m, Number(named[2]));
  }
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (slashed) return validIso(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));
  return null;
}

/** The date the total is from: "as of …", else a statement period's end, else a statement date. */
function asOfDate(lines: string[]): string | null {
  const text = lines.slice(0, 150);
  for (const pattern of [
    /\bas of\b(.*)/i,
    /\bperiod\b.*?(?:-|–|to|through)(.*)/i,
    /\bstatement date\b(.*)/i,
    /\bending\b(.*)/i,
  ])
    for (const line of text) {
      const m = pattern.exec(line);
      const date = m ? readDate(m[1] ?? "") : null;
      if (date) return date;
    }
  return null;
}

function kindOf(text: string, kinds: [RegExp, string, string][], fallback: [string, string]) {
  for (const [re, label, group] of kinds) if (re.test(text)) return { label, group, from: label };
  return { label: fallback[0], group: fallback[1], from: null };
}

/** An account number printed masked: "Account ending in 1234", "Acct ****1234", "XXXX-1234". */
const MASKED_ACCOUNT =
  /(?:account|acct)[^\d]{0,24}?(?:[*xX•.]{2,}-?|ending in|ending)\s*(\d{4})\b/i;
/** An account number printed whole, after "Account number:" or a kind of account and a colon. */
const WHOLE_ACCOUNT = [
  /\b(?:account|acct)\s*(?:number|no\.?|#)\s*[:#]?\s*([a-z]{0,3}[\d][\d -]{4,}\d)\b/i,
  /\b(?:brokerage|ira|401\s?\(?k\)?|403\s?\(?b\)?|hsa|loan|mortgage)\s*(?:account|number|no\.?)?\s*[:#]\s*([a-z]{0,3}\d[\d -]{4,}\d)\b/i,
];

/** The last four of the account number a document prints, or null. Never more than four. */
export function accountLast4(lines: string[]): string | null {
  const head = lines.slice(0, 150);
  for (const line of head) {
    const m = MASKED_ACCOUNT.exec(line);
    if (m) return m[1] ?? null;
  }
  for (const re of WHOLE_ACCOUNT)
    for (const line of head) {
      const digits = (re.exec(line)?.[1] ?? "").replace(/\D/g, "");
      if (digits.length >= 6) return digits.slice(-4);
    }
  return null;
}

/**
 * A document's total, when it is an investment or a loan document with one; null otherwise (a
 * bank or card statement, which is read for its transactions instead).
 */
export async function readDocumentTotal(
  lines: string[],
  parseAmount: (text: string) => Promise<number>,
): Promise<DocumentTotal | null> {
  const head = lines.slice(0, 150).join(" ");
  const lower = head.toLowerCase();
  const read = async (raw: string | null) => {
    if (!raw) return null;
    const cleaned = raw.replace(/[$()\s]/g, "").replace(/^-/, "");
    try {
      const cents = await parseAmount(cleaned);
      return cents > 0 ? cents : null;
    } catch {
      return null;
    }
  };

  if (LOAN_WORDS.test(head) && lower.includes("principal")) {
    for (const phrase of LOAN_TOTALS) {
      const cents = await read(amountAfter(lines, phrase));
      if (cents === null) continue;
      const { label, group, from } = kindOf(head, LOAN_KINDS, ["Loan", "personal_loan"]);
      return {
        kind: "debt",
        group,
        label,
        cents,
        as_of: asOfDate(lines),
        doc: "loan",
        last4: accountLast4(lines),
        kind_from: from,
      };
    }
    return null;
  }

  const investment =
    looksLikeHoldings(lines) ||
    (/(account|portfolio) value|account total/.test(lower) &&
      ACCOUNT_KINDS.some(([re]) => re.test(head)));
  if (!investment) return null;
  for (const phrase of INVESTMENT_TOTALS) {
    const cents = await read(amountAfter(lines, phrase));
    if (cents === null) continue;
    const { label, group, from } = kindOf(head, ACCOUNT_KINDS, ["Investments", "investments"]);
    return {
      kind: "asset",
      group,
      label,
      cents,
      as_of: asOfDate(lines),
      doc: "investments",
      last4: accountLast4(lines),
      kind_from: from,
    };
  }
  return null;
}

/**
 * A positions export as CSV (Symbol and a value column): the sum of every holding's value, named
 * from the account column when there is one account. Rows without a symbol (totals, pending
 * activity, notes) are left out.
 */
export async function readCsvTotal(
  headers: string[],
  rows: string[][],
  parseAmount: (text: string) => Promise<number>,
): Promise<DocumentTotal | null> {
  const h = headers.map((x) => x.trim().toLowerCase());
  const symbol = h.indexOf("symbol");
  const value = ["current value", "market value", "total value", "value"]
    .map((name) => h.indexOf(name))
    .find((i) => i >= 0);
  if (symbol < 0 || value === undefined) return null;
  const accountCol = h.findIndex((x) => x === "account name" || x === "account");
  const numberCol = h.findIndex((x) => x === "account number" || x === "account #");
  let cents = 0;
  let found = 0;
  const names = new Set<string>();
  const numbers = new Set<string>();
  for (const row of rows) {
    const sym = (row[symbol] ?? "").trim();
    if (!sym || /pending|total/i.test(sym)) continue;
    const raw = (row[value] ?? "").replace(/[$\s]/g, "");
    if (!/^-?[\d,]*\d(\.\d+)?$/.test(raw)) continue;
    try {
      cents += await parseAmount(raw.replace(/^-/, ""));
      found += 1;
    } catch {
      // a value the engine can't read is left out
    }
    if (accountCol >= 0) names.add((row[accountCol] ?? "").trim());
    if (numberCol >= 0) numbers.add((row[numberCol] ?? "").replace(/\D/g, ""));
  }
  if (found === 0 || cents <= 0) return null;
  const named = names.size === 1 ? ([...names][0] ?? "") : "";
  const { label, group, from } = kindOf(named, ACCOUNT_KINDS, ["Investments", "investments"]);
  const number = numbers.size === 1 ? ([...numbers][0] ?? "") : "";
  const allText = rows.map((r) => r.join(" ")).join(" ");
  const downloaded = /date downloaded\s*(.*)/i.exec(allText);
  return {
    kind: "asset",
    group,
    label,
    cents,
    as_of: downloaded ? readDate(downloaded[1] ?? "") : null,
    doc: "investments",
    last4: number.length >= 4 ? number.slice(-4) : null,
    kind_from: from,
  };
}
