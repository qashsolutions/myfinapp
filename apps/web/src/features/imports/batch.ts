import type { Account, StackdDb } from "../../data/db.ts";
import { maskFileName } from "../../importers/masking.ts";
import type { DocumentTotal } from "../../importers/totals.ts";
import type { Entitlements } from "../billing/entitlements.ts";
import { commitImport, type ParsedFile, pdfForAccount, prepareRows } from "./importFlow.ts";

/**
 * Several files at once on Import (owner decisions, November 16, 2026; the "Qash multi-file
 * upload" canvas): the plan's limits applied in the order picked, then each file read on this
 * device one after another. Nothing is added until the person taps Add, Import or Do all.
 */

export type RowStatus =
  | "waiting"
  | "reading"
  | "total" // a document with a total for Net worth, read
  | "statement" // a statement of transactions, read
  | "refused" // couldn't be read: `note` says why
  | "too_big" // over the per-file limit
  | "later" // over the plan's file count or batch size: for the next batch
  | "stopped" // the person stopped reading before this one
  | "done"; // added: `note` says what it became

export interface BatchRow {
  id: string;
  file: File;
  status: RowStatus;
  note: string | null;
  total?: DocumentTotal;
  parsed?: ParsedFile;
  text?: string;
  /** A statement's account when it is known without asking: the only one with its last four. */
  account?: Account | null;
}

export const MB = 1024 * 1024;

export type ImportLimits = Pick<
  Entitlements,
  "import_files_max" | "import_file_mb" | "import_batch_mb"
>;

/**
 * The plan's limits over the files in the order picked: past the file count, or past the batch
 * size, a file waits for the next batch; a file over the per-file size is too big. Files too big
 * don't count toward the batch.
 */
export function planBatch(files: File[], limits: ImportLimits): BatchRow[] {
  const fileMax = limits.import_file_mb * MB;
  const batchMax = limits.import_batch_mb * MB;
  let used = 0;
  let taken = 0;
  return files.map((file, i) => {
    const id = `f${i}`;
    if (file.size > fileMax)
      return {
        id,
        file,
        status: "too_big",
        note: `${sizeOf(file.size)}, too big: ${limits.import_file_mb} MB a file. Download one month or a CSV instead.`,
      };
    if (taken >= limits.import_files_max || used + file.size > batchMax)
      return { id, file, status: "later", note: "Left for the next batch" };
    taken += 1;
    used += file.size;
    return { id, file, status: "waiting", note: null };
  });
}

export function sizeOf(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What a picked batch left out, said once above the list; null when everything fits. */
export function limitsNote(rows: BatchRow[], limits: ImportLimits, plan: string): string | null {
  const later = rows.filter((r) => r.status === "later").length;
  if (later === 0) return null;
  return `You picked ${rows.length} files. ${plan} reads ${limits.import_files_max} at a time and ${limits.import_batch_mb} MB in all, so ${later === 1 ? "1 waits" : `${later} wait`} for the next batch.`;
}

/** The statement's last four, as the statement says it. */
function last4Of(parsed: ParsedFile): string | null {
  return parsed.ofx?.account.last4 ?? parsed.pdf?.account.last4 ?? null;
}

/**
 * The account a statement goes into without asking: the only account with its last four, when
 * the plan lets statements go into it. A CSV never says, so it is always checked.
 */
export function accountFor(
  parsed: ParsedFile,
  accounts: Account[],
  importedInto: Set<string>,
  accountsMax: number | null,
): Account | null {
  if (parsed.format === "csv") return null;
  const last4 = last4Of(parsed);
  if (!last4) return null;
  const same = accounts.filter((a) => a.last4 === last4);
  if (same.length !== 1) return null;
  const account = same[0] as Account;
  const allowed =
    accountsMax === null || importedInto.has(account.id) || importedInto.size < accountsMax;
  return allowed ? account : null;
}

/**
 * One statement imported as the review screen would with nothing changed: duplicates skipped,
 * likely transfers marked, the file not kept. Returns what it added.
 */
export async function importReady(
  db: StackdDb,
  row: BatchRow,
): Promise<{ added: number; skipped: number }> {
  const parsed = row.parsed;
  const account = row.account;
  if (!parsed || !account) throw new Error("not_ready");
  let rows = parsed.ofx?.rows;
  let ledger = parsed.ofx?.ledger ?? null;
  let templateKey: string | null = null;
  if (!rows) {
    const pdf = await pdfForAccount(parsed, account.type);
    if (!pdf) throw new Error("not_ready");
    rows = pdf.rows;
    ledger = pdf.ledger;
    templateKey = pdf.template_key;
  }
  const prepared = await prepareRows(db, account.id, rows, ledger);
  const transfers = new Set(
    prepared.rows
      .filter((r) => !r.duplicate && (r.is_transfer_hint || r.match))
      .map((r) => r.fingerprint),
  );
  await commitImport(db, {
    account,
    format: parsed.format,
    fileName: maskFileName(row.file.name),
    prepared,
    transfers,
    keepFile: false,
    period: parsed.ofx?.period ?? parsed.pdf?.period,
    templateKey,
  });
  return { added: prepared.fresh, skipped: prepared.duplicates };
}
