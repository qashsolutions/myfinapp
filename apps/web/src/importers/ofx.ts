/**
 * OFX and QFX statements (SGML 1.x and XML 2.x), parsed on the device. Standard fields:
 * account id and type, each STMTTRN (date, amount, name, memo), the ledger balance that
 * anchors the forecast, and the statement period.
 */

import type { AccountType } from "../data/db.ts";
import type { MappedRow } from "./csv.ts";
import { last4, maskNumbers } from "./masking.ts";

export interface OfxStatement {
  account: { last4: string | null; type: AccountType | null; institution: string | null };
  rows: MappedRow[];
  ledger: { cents: number; as_of: string } | null;
  period: { start: string | null; end: string | null };
  skipped: number;
}

const TAG = /<(\/?)([A-Za-z0-9_.]+)>([^<]*)/g;

function ofxDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function accountType(acctType: string | null, creditCard: boolean): AccountType | null {
  if (creditCard) return "credit_card";
  if (!acctType) return null;
  const t = acctType.toUpperCase();
  if (t === "CHECKING") return "checking";
  if (t === "SAVINGS" || t === "MONEYMRKT") return "savings";
  if (t === "CREDITLINE" || t === "CREDITCARD") return "credit_card";
  return null;
}

/** NAME, plus MEMO when it adds something; a MEMO that repeats the NAME replaces it. */
function joinNameMemo(name: string, memo: string): string {
  if (!name) return memo;
  if (!memo || name.includes(memo)) return name;
  if (memo.startsWith(name)) return memo;
  return `${name} ${memo}`;
}

export function looksLikeOfx(text: string): boolean {
  return /<OFX>/i.test(text) || /^OFXHEADER/i.test(text.trimStart());
}

export async function parseOfx(
  text: string,
  parseAmount: (text: string) => Promise<number>,
): Promise<OfxStatement> {
  const start = text.search(/<OFX>/i);
  const body = start === -1 ? text : text.slice(start);
  const stack: string[] = [];
  let txn: Record<string, string> | null = null;
  const txns: Record<string, string>[] = [];
  const fields: Record<string, string> = {};
  let creditCard = false;
  let acctId: string | null = null;
  const path = () => stack.join("/");

  for (const m of body.matchAll(TAG)) {
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toUpperCase();
    const value = (m[3] ?? "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (closing) {
      if (name === "STMTTRN" && txn) {
        txns.push(txn);
        txn = null;
      }
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
      continue;
    }
    if (value === "") {
      if (name === "STMTTRN") {
        if (txn) txns.push(txn); // SGML files sometimes omit </STMTTRN>
        txn = {};
      }
      if (name === "CCACCTFROM" || name === "CCSTMTRS") creditCard = true;
      stack.push(name);
      continue;
    }
    // a leaf element with a value
    if (txn && stack[stack.length - 1] === "STMTTRN") txn[name] = value;
    else if (name === "ACCTID" && /ACCTFROM$/.test(stack[stack.length - 1] ?? "")) acctId = value;
    else if (name === "BALAMT" && stack[stack.length - 1] === "LEDGERBAL") fields.BALAMT = value;
    else if (name === "DTASOF" && stack[stack.length - 1] === "LEDGERBAL") fields.DTASOF = value;
    else if (name === "DTSTART" || name === "DTEND" || name === "ACCTTYPE" || name === "ORG")
      fields[name] = value;
    void path;
  }
  if (txn) txns.push(txn);

  const rows: MappedRow[] = [];
  let skipped = 0;
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i] as Record<string, string>;
    const date = ofxDate(t.DTPOSTED ?? "");
    let cents: number | null = null;
    try {
      cents = t.TRNAMT ? await parseAmount(t.TRNAMT) : null;
    } catch {
      cents = null;
    }
    if (!date || cents === null) {
      skipped += 1;
      continue;
    }
    const name = (t.NAME ?? "").trim();
    const memo = (t.MEMO ?? "").trim();
    const description = maskNumbers(joinNameMemo(name, memo));
    rows.push({ row: i + 1, date, description, amount_cents: cents, balance_cents: null });
  }

  let ledger: OfxStatement["ledger"] = null;
  if (fields.BALAMT && fields.DTASOF) {
    try {
      const asOf = ofxDate(fields.DTASOF);
      const cents = await parseAmount(fields.BALAMT);
      if (asOf) ledger = { cents, as_of: asOf };
    } catch {
      ledger = null;
    }
  }
  return {
    account: {
      last4: last4(acctId),
      type: accountType(fields.ACCTTYPE ?? null, creditCard),
      institution: fields.ORG ?? null,
    },
    rows,
    ledger,
    period: { start: ofxDate(fields.DTSTART ?? ""), end: ofxDate(fields.DTEND ?? "") },
    skipped,
  };
}
