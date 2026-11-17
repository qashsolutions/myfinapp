import type { StackdDb } from "../../data/db.ts";
import type { DocumentTotal } from "../../importers/totals.ts";
import { compareText } from "../../lib/order.ts";

/**
 * Has this been added before? (owner decision, November 16, 2026). Three checks, strongest
 * first: the file's own bytes (SHA-256 on this device, so a renamed copy is still the same
 * file; only the hash is kept, never the file), then what the document says (a total's kind,
 * name, amount and date; a statement whose every transaction is already in Qash), and the file
 * name only as a hint on the upload screen. Each answer is a Your documents id
 * (`statement:<id>` / `document:<id>`), so the screen can say when it was added and what it
 * became. Nothing is blocked: the person can always add it anyway.
 */

/** The file's SHA-256 in hex, computed on this device; null where the browser can't. */
export async function fileSha256(file: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** The newest statement or document added from these exact bytes. */
export async function sameFile(db: StackdDb, sha: string | null): Promise<string | null> {
  if (!sha) return null;
  const [statements, documents] = await Promise.all([
    db.statement_imports.filter((s) => s.file_sha256 === sha).toArray(),
    db.document_imports.filter((d) => d.file_sha256 === sha).toArray(),
  ]);
  const found = [
    ...statements.map((s) => ({ at: s.created_at, id: `statement:${s.id}` })),
    ...documents.map((d) => ({ at: d.created_at, id: `document:${d.id}` })),
  ].sort((a, b) => compareText(b.at, a.at));
  return found[0]?.id ?? null;
}

/** A document whose total was added before with the same kind, name, amount and date. */
export async function sameTotal(db: StackdDb, total: DocumentTotal): Promise<string | null> {
  const label = total.label.trim().toLowerCase();
  const same = await db.document_imports
    .filter(
      (d) =>
        d.kind === total.kind &&
        d.label.trim().toLowerCase() === label &&
        d.cents === total.cents &&
        (d.as_of ?? null) === (total.as_of ?? null),
    )
    .toArray();
  const newest = same.sort((a, b) => compareText(b.created_at, a.created_at))[0];
  return newest ? `document:${newest.id}` : null;
}

/** The newest statement imported into this account: what a file with nothing new repeats. */
export async function lastStatementInto(db: StackdDb, accountId: string): Promise<string | null> {
  const into = await db.statement_imports.where("account_id").equals(accountId).toArray();
  const newest = into.sort((a, b) => compareText(b.created_at, a.created_at))[0];
  return newest ? `statement:${newest.id}` : null;
}
