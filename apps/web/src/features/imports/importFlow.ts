/**
 * The import pipeline, free of React so tests can drive it: detect the format, parse on the
 * device, fingerprint and categorise every row through the engine, skip what is already
 * imported, then write everything in one transaction. Nothing here touches the network.
 */

import keywords from "@stackd/rules/keywords";
import {
  type Account,
  type AccountType,
  type CsvMapping,
  type Direction,
  type Entry,
  type ImportFormat,
  newId,
  type StackdDb,
  type StatementImport,
} from "../../data/db.ts";
import { storeFile } from "../../data/files.ts";
import { engine, matchTransfers, parseAmount, type RuleEntry } from "../../engine/bridge.ts";
import { type CsvTable, guessMapping, type MappedRow, parseCsv } from "../../importers/csv.ts";
import { looksLikeOfx, type OfxStatement, parseOfx } from "../../importers/ofx.ts";
import { type PdfStatement, parsePdf } from "../../importers/pdf/index.ts";
import { addDaysIso } from "../../lib/dates.ts";
import { compareText } from "../../lib/order.ts";
import { savedNames } from "../entries/entryActions.ts";

export function detectFormat(name: string, text: string): ImportFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || text.startsWith("%PDF-")) return "pdf";
  if (ext === "ofx" || ext === "qfx" || looksLikeOfx(text)) return "ofx";
  if (ext === "csv" || text.includes(",")) return "csv";
  return null;
}

export interface ParsedFile {
  format: ImportFormat;
  csv?: CsvTable;
  ofx?: OfxStatement;
  pdf?: PdfStatement;
  rowCount: number;
}

/** A PDF statement (fast-follow 2): bytes, not text; the text layer is read on the device. */
export async function parsePdfFile(bytes: Uint8Array): Promise<ParsedFile> {
  const pdf = await parsePdf(bytes, parseAmount);
  return { format: "pdf", pdf, rowCount: pdf.rows.length };
}

export async function parseFile(name: string, text: string): Promise<ParsedFile> {
  const format = detectFormat(name, text);
  if (format === "ofx") {
    const ofx = await parseOfx(text, parseAmount);
    return { format, ofx, rowCount: ofx.rows.length };
  }
  if (format === "csv") {
    const csv = parseCsv(text);
    return { format, csv, rowCount: csv.rows.length };
  }
  throw new Error("unsupported_format");
}

export async function mappingFor(
  db: StackdDb,
  accountId: string,
  table: CsvTable,
): Promise<{ mapping: CsvMapping; remembered: boolean }> {
  const saved = await db.csv_mappings.get(accountId);
  if (
    saved &&
    saved.mapping.date < table.headers.length &&
    saved.mapping.description < table.headers.length
  ) {
    return { mapping: saved.mapping, remembered: true };
  }
  return { mapping: guessMapping(table), remembered: false };
}

export interface PreparedRow extends MappedRow {
  direction: Direction;
  abs_cents: number;
  fingerprint: string;
  clean_description: string;
  category_id: string | null;
  matched_by: "user" | "keyword" | "model" | null;
  is_transfer_hint: boolean;
  duplicate: boolean;
  /** An existing entry in another account that looks like the other side of this transfer. */
  match: {
    entry_id: string;
    account_id: string;
    amount_cents: number;
    direction: Direction;
    days_apart: number;
  } | null;
}

export interface Prepared {
  rows: PreparedRow[];
  found: number;
  fresh: number;
  duplicates: number;
  categorized: number;
  uncategorized: number;
  ending_balance: { cents: number; as_of: string } | null;
}

export interface Categorized {
  category_id: string | null;
  matched_by: "user" | "keyword" | "model" | null;
  is_transfer_hint: boolean;
}

/**
 * The categoriser every money-in path shares (imports, linked sync): the user's own rules, then
 * the keyword table, then, for money out only, the bundled model above its floors.
 */
export async function loadCategorizer(
  db: StackdDb,
): Promise<(description: string, direction: Direction) => Promise<Categorized>> {
  const userRules = (await db.merchant_rules.toArray()).map((r) => ({
    match: r.match,
    category_id: r.category_id,
  }));
  const knownCategories = new Set((await db.categories.toArray()).map((c) => c.id));
  // Loaded on first use as its own chunk (about 56 KB gzipped); precached for offline use.
  const { default: categorizer } = await import("@stackd/rules/categorizer");
  return async (description, direction) => {
    const cat = await engine.call<{
      category_id: string | null;
      matched_by: "user" | "keyword" | null;
      is_transfer_hint: boolean;
    }>("categorize.match", {
      description,
      direction,
      user_rules: userRules,
      keywords,
    });
    let categoryId = cat.category_id;
    let matchedBy: Categorized["matched_by"] = cat.matched_by;
    if (categoryId === null && !cat.is_transfer_hint && direction === "out") {
      // Fast-follow 7: the bundled model suggests known merchants the tables missed. It only
      // ever answers with a default category above its confidence floors, never a guess, and
      // the preview shows the category for review like any keyword match.
      const suggested = await engine.call<{ category_id: string | null }>("categorize.suggest", {
        description,
        model: categorizer,
      });
      if (suggested.category_id !== null && knownCategories.has(suggested.category_id)) {
        categoryId = suggested.category_id;
        matchedBy = "model";
      }
    }
    return {
      category_id: categoryId,
      matched_by: matchedBy,
      is_transfer_hint: cat.is_transfer_hint,
    };
  };
}

/** Fingerprint, dedupe and categorise. Identical rows within one file get a numbered suffix. */
export async function prepareRows(
  db: StackdDb,
  accountId: string,
  mapped: MappedRow[],
  ledger: OfxStatement["ledger"] = null,
): Promise<Prepared> {
  const categorize = await loadCategorizer(db);
  const seen = new Map<string, number>();
  const rows: PreparedRow[] = [];
  for (const row of mapped) {
    const direction: Direction = row.amount_cents < 0 ? "out" : "in";
    const fp = await engine.call<{ fingerprint: string; clean_description: string }>(
      "fingerprint.row",
      {
        account_id: accountId,
        date: row.date,
        amount_cents: row.amount_cents,
        description: row.description,
      },
    );
    const n = (seen.get(fp.fingerprint) ?? 0) + 1;
    seen.set(fp.fingerprint, n);
    const fingerprint = n === 1 ? fp.fingerprint : `${fp.fingerprint}-${n}`;
    const duplicate =
      (await db.entries
        .where("[account_id+fingerprint]")
        .equals([accountId, fingerprint])
        .count()) > 0;
    const cat = await categorize(row.description, direction);
    rows.push({
      ...row,
      direction,
      abs_cents: Math.abs(row.amount_cents),
      fingerprint,
      clean_description: fp.clean_description,
      category_id: cat.category_id,
      matched_by: cat.matched_by,
      is_transfer_hint: cat.is_transfer_hint,
      duplicate,
      match: null,
    });
  }
  const fresh = rows.filter((r) => !r.duplicate);
  await attachTransferMatches(db, accountId, fresh);
  let ending: Prepared["ending_balance"] = ledger
    ? { cents: ledger.cents, as_of: ledger.as_of }
    : null;
  if (!ending) {
    const withBalance = mapped
      .filter((r) => r.balance_cents !== null)
      .sort((a, b) => compareText(b.date, a.date) || a.row - b.row);
    const latest = withBalance[0];
    if (latest && latest.balance_cents !== null)
      ending = { cents: latest.balance_cents, as_of: latest.date };
  }
  return {
    rows,
    found: rows.length,
    fresh: fresh.length,
    duplicates: rows.length - fresh.length,
    categorized: fresh.filter((r) => r.category_id !== null && !r.is_transfer_hint).length,
    uncategorized: fresh.filter((r) => r.category_id === null && !r.is_transfer_hint).length,
    ending_balance: ending,
  };
}

/** cashflow.match_transfers over the new rows plus existing entries in other accounts nearby. */
async function attachTransferMatches(
  db: StackdDb,
  accountId: string,
  fresh: PreparedRow[],
): Promise<void> {
  if (fresh.length === 0) return;
  const dates = fresh.map((r) => r.date).sort();
  const lo = addDaysIso(dates[0] as string, -5);
  const hi = addDaysIso(dates[dates.length - 1] as string, 5);
  const others = (await db.entries.where("date").between(lo, hi, true, true).toArray()).filter(
    (e) => e.account_id !== accountId && !e.is_transfer,
  );
  const candidates: RuleEntry[] = [
    ...fresh.map((r) => ({
      id: `row:${r.fingerprint}`,
      date: r.date,
      amount_cents: r.abs_cents,
      direction: r.direction,
      is_transfer: false,
      category_id: null,
      category_kind: null,
      account_id: accountId,
    })),
    ...others.map((e) => ({
      id: e.id,
      date: e.date,
      amount_cents: e.amount_cents,
      direction: e.direction,
      is_transfer: false,
      category_id: null,
      category_kind: null,
      account_id: e.account_id,
    })),
  ];
  const byId = new Map(others.map((e) => [e.id, e]));
  const byFingerprint = new Map(fresh.map((r) => [`row:${r.fingerprint}`, r]));
  for (const pair of await matchTransfers(candidates)) {
    const rowSide = byFingerprint.get(pair.out_id) ?? byFingerprint.get(pair.in_id);
    const otherId = byFingerprint.has(pair.out_id) ? pair.in_id : pair.out_id;
    const other = byId.get(otherId);
    if (!rowSide || !other) continue; // two rows of this file, or two existing entries: nothing to show
    rowSide.match = {
      entry_id: other.id,
      account_id: other.account_id,
      amount_cents: other.amount_cents,
      direction: other.direction,
      days_apart: pair.days_apart,
    };
  }
}

export interface CommitInput {
  account: Account;
  format: ImportFormat;
  fileName: string;
  prepared: Prepared;
  transfers: Set<string>; // fingerprints the user confirmed as transfers
  templateKey?: string | null; // PDF statements: which template read it
  mapping?: CsvMapping;
  rememberMapping?: boolean;
  file?: File | null;
  keepFile?: boolean;
  period?: { start: string | null; end: string | null };
  now?: Date;
}

/** One transaction: entries, the import record, the balance anchor, the mapping and the file copy. */
export async function commitImport(db: StackdDb, input: CommitInput): Promise<StatementImport> {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const importId = newId();
  const fresh = input.prepared.rows.filter((r) => !r.duplicate);
  const names = await savedNames(db);
  const entries: Entry[] = fresh.map((r) => ({
    id: newId(),
    date: r.date,
    amount_cents: r.abs_cents,
    direction: r.direction,
    merchant:
      names.get(r.clean_description) ??
      (r.description || (r.direction === "in" ? "Money in" : "Money out")),
    clean_description: r.clean_description,
    raw_description: r.description,
    category_id: input.transfers.has(r.fingerprint) ? null : r.category_id,
    account_id: input.account.id,
    source: "import",
    receipt_id: null,
    import_id: importId,
    fingerprint: r.fingerprint,
    is_transfer: input.transfers.has(r.fingerprint),
    transfer_pair_id: input.transfers.has(r.fingerprint) ? (r.match?.entry_id ?? null) : null,
    split_parent_id: null,
    is_recurring: false,
    created_at: stamp,
    updated_at: stamp,
  }));
  const dates = fresh.map((r) => r.date).sort();
  const record: StatementImport = {
    id: importId,
    account_id: input.account.id,
    format: input.format,
    template_key: input.templateKey ?? null,
    file_name: input.fileName,
    period_start: input.period?.start ?? dates[0] ?? null,
    period_end: input.period?.end ?? dates[dates.length - 1] ?? null,
    ending_balance_cents: input.prepared.ending_balance?.cents ?? null,
    rows_found: input.prepared.found,
    rows_added: entries.length,
    rows_skipped: input.prepared.duplicates,
    file_key: null,
    status: "done",
    created_at: stamp,
  };
  await db.transaction(
    "rw",
    [db.entries, db.statement_imports, db.balance_anchors, db.csv_mappings, db.files],
    async () => {
      if (entries.length) await db.entries.bulkAdd(entries);
      // A confirmed transfer with a match marks the other side too, or that side would still
      // count as money in or out and skew Kept by the transfer's amount.
      for (const e of entries) {
        if (!e.transfer_pair_id) continue;
        const other = await db.entries.get(e.transfer_pair_id);
        if (!other || other.is_transfer) {
          await db.entries.update(e.id, { transfer_pair_id: null });
          continue;
        }
        await db.entries.put({
          ...other,
          is_transfer: true,
          category_id: null,
          transfer_pair_id: e.id,
          updated_at: stamp,
        });
      }
      if (input.prepared.ending_balance) {
        await db.balance_anchors.add({
          id: newId(),
          account_id: input.account.id,
          as_of: input.prepared.ending_balance.as_of,
          balance_cents: input.prepared.ending_balance.cents,
          source: "statement",
          created_at: stamp,
        });
      }
      if (input.mapping && input.rememberMapping) {
        await db.csv_mappings.put({
          account_id: input.account.id,
          mapping: input.mapping,
          updated_at: stamp,
        });
      }
      if (input.file && input.keepFile) {
        const stored = await storeFile(db, input.file, "statement", importId, now);
        record.file_key = stored.id;
      }
      await db.statement_imports.add(record);
    },
  );
  return record;
}

export async function createAccount(
  db: StackdDb,
  label: string,
  type: AccountType,
  last4: string | null,
  institution: string | null = null,
  now: Date = new Date(),
): Promise<Account> {
  const account: Account = {
    id: newId(),
    label: label.trim(),
    type,
    last4,
    institution,
    currency: "USD",
    created_at: now.toISOString(),
  };
  await db.accounts.add(account);
  return account;
}
