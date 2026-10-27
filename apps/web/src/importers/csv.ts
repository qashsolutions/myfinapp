/**
 * CSV statements, parsed on the device (docs/spec.md "Statement import": column mapping for
 * date, description, amount or debit/credit, balance; saved per account).
 */

import type { CsvMapping, DateFormat } from "../data/db.ts";
import { maskNumbers } from "./masking.ts";

export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

/** A row after mapping: signed cents (negative = money out), ISO date, masked description. */
export interface MappedRow {
  row: number; // 1-based line in the file, for messages
  date: string;
  description: string;
  amount_cents: number;
  balance_cents: number | null;
}

export interface SkippedRow {
  row: number;
  reason: "date" | "amount" | "empty";
}

function detectDelimiter(firstLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 with the usual bank quirks: BOM, CRLF, quoted fields with commas and doubled quotes. */
export function parseCsv(text: string): CsvTable {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else field += c;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const out = r.map((cell) => cell.trim());
    while (out.length < headers.length) out.push("");
    return out.slice(0, headers.length);
  });
  return { headers, rows, delimiter };
}

const HEADER_PATTERNS: Array<[keyof Omit<CsvMapping, "sign" | "date_format">, RegExp]> = [
  ["debit", /debit|withdraw|money out|outflow|charge/i],
  ["credit", /credit|deposit|money in|inflow/i],
  ["balance", /balance/i],
  ["amount", /amount|^amt$/i],
  ["date", /date|posted/i],
  ["description", /description|memo|payee|name|details|narrative|merchant/i],
];

function findColumn(headers: string[], pattern: RegExp, taken: Set<number>): number | null {
  const index = headers.findIndex((h, i) => !taken.has(i) && pattern.test(h));
  return index === -1 ? null : index;
}

/** Guess the date format from sample cells: 4-digit first part → YMD; a first part over 12 → DMY. */
export function guessDateFormat(samples: string[]): DateFormat {
  let sawDayFirst = false;
  for (const s of samples) {
    const parts = s.trim().split(/[/\-.]/);
    if (parts.length !== 3) continue;
    const [a, b] = parts;
    if ((a ?? "").length === 4) return "YMD";
    if (Number(a) > 12) sawDayFirst = true;
    if (Number(b) > 12) return "MDY";
  }
  return sawDayFirst ? "DMY" : "MDY";
}

/** Our best guess from the header row; the user checks it once and it is remembered per account. */
export function guessMapping(table: CsvTable): CsvMapping {
  const taken = new Set<number>();
  const picked: Partial<Record<string, number | null>> = {};
  for (const [field, pattern] of HEADER_PATTERNS) {
    const col = findColumn(table.headers, pattern, taken);
    picked[field] = col;
    if (col !== null) taken.add(col);
  }
  // A "credit" column next to a plain "amount" column is usually a card-type label, not money in.
  const amount = picked.amount ?? null;
  let debit = picked.debit ?? null;
  let credit = picked.credit ?? null;
  if (amount !== null && (debit === null || credit === null)) {
    debit = null;
    credit = null;
  }
  const date = picked.date ?? 0;
  const description = picked.description ?? (table.headers.length > 1 ? 1 : 0);
  const samples = table.rows.slice(0, 20).map((r) => r[date] ?? "");
  return {
    date,
    description,
    amount: amount ?? (debit === null && credit === null ? firstNumericColumn(table, taken) : null),
    debit,
    credit,
    balance: picked.balance ?? null,
    sign: "negative_out",
    date_format: guessDateFormat(samples),
  };
}

function firstNumericColumn(table: CsvTable, taken: Set<number>): number | null {
  const row = table.rows[0] ?? [];
  const index = row.findIndex((cell, i) => !taken.has(i) && /^[-+($]*\d/.test(cell.trim()));
  return index === -1 ? null : index;
}

/** "10/08/2026", "08-10-2026", "2026-10-08", "10/8/26" → ISO, by the chosen format; null if not a date. */
export function parseDateCell(cell: string, format: DateFormat): string | null {
  const trimmed = cell.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parts = trimmed.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  let y: number;
  let m: number;
  let d: number;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  if (format === "YMD") [y, m, d] = [a, b, c];
  else if (format === "DMY") [d, m, y] = [a, b, c];
  else [m, d, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface ApplyResult {
  rows: MappedRow[];
  skipped: SkippedRow[];
}

/** Turn the table into rows the import can use. `parseAmount` is the engine's money.parse_amount. */
export async function applyMapping(
  table: CsvTable,
  mapping: CsvMapping,
  parseAmount: (text: string) => Promise<number>,
): Promise<ApplyResult> {
  const rows: MappedRow[] = [];
  const skipped: SkippedRow[] = [];
  const tryParse = async (cell: string | undefined): Promise<number | null> => {
    if (!cell || cell.trim() === "") return null;
    try {
      return await parseAmount(cell);
    } catch {
      return null;
    }
  };
  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i] ?? [];
    const line = i + 2;
    const date = parseDateCell(r[mapping.date] ?? "", mapping.date_format);
    if (!date) {
      skipped.push({ row: line, reason: "date" });
      continue;
    }
    let cents: number | null = null;
    if (mapping.amount !== null) {
      cents = await tryParse(r[mapping.amount]);
      if (cents !== null && mapping.sign === "negative_in") cents = -cents;
    } else {
      const debit = mapping.debit === null ? null : await tryParse(r[mapping.debit]);
      const credit = mapping.credit === null ? null : await tryParse(r[mapping.credit]);
      if (debit !== null && debit !== 0) cents = -Math.abs(debit);
      else if (credit !== null && credit !== 0) cents = Math.abs(credit);
      else if (debit === 0 || credit === 0) cents = 0;
    }
    if (cents === null) {
      skipped.push({ row: line, reason: "amount" });
      continue;
    }
    const description = maskNumbers((r[mapping.description] ?? "").trim());
    if (description === "" && cents === 0) {
      skipped.push({ row: line, reason: "empty" });
      continue;
    }
    const balance = mapping.balance === null ? null : await tryParse(r[mapping.balance]);
    rows.push({ row: line, date, description, amount_cents: cents, balance_cents: balance });
  }
  return { rows, skipped };
}
