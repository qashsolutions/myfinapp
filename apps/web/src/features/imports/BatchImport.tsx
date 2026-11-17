import { Button, buttonClass, Card, Sheet } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { readFileText } from "../../data/files.ts";
import { maskFileName } from "../../importers/masking.ts";
import { PdfError } from "../../importers/pdf/index.ts";
import { formatCents, formatDate } from "../../lib/format.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { GROUP_LABEL, saveFromDocument } from "../networth/useNetWorth.ts";
import { accountFor, type BatchRow, importReady, limitsNote, sizeOf } from "./batch.ts";
import { DocumentTotalCard } from "./DocumentTotalCard.tsx";
import { type DocRow, useDocumentHistory } from "./documentHistory.ts";
import { fileSha256, sameFile, sameTotal } from "./duplicates.ts";
import { fileSummary } from "./fileSummary.ts";
import { readPdfForImport, readTextForImport } from "./importFlow.ts";

const PLAN_NAME: Record<string, string> = {
  free: "Your plan",
  private: "Private",
  connected: "Connected",
  founding: "Founding",
};

/** Why a file couldn't be read, in one line. */
function refusal(err: unknown): string {
  if (err instanceof PdfError)
    return err.code === "no_text"
      ? "Not read: a scanned image, no text"
      : err.code === "holdings"
        ? "Not read: investments you own, no total found"
        : "Not read: a layout Qash doesn't know yet";
  return "Not read: not a statement Qash can read";
}

const isPdf = (f: File) => f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf";

/**
 * The files picked together (the "Qash multi-file upload" canvas, screens 2–6): read one after
 * another on this device, each row saying what it is as soon as it's read; Check opens one, Do
 * all adds every one that needs no question. Nothing is added until the person taps.
 */
export function BatchImport({
  rows,
  setRows,
  onCheckStatement,
  onAddMore,
}: {
  rows: BatchRow[];
  setRows: (update: (rows: BatchRow[]) => BatchRow[]) => void;
  onCheckStatement: (row: BatchRow) => void;
  onAddMore: () => void;
}) {
  const { db } = useDb();
  const { entitlements } = useEntitlements();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [db]);
  const importedInto = useLiveQuery(
    async () => new Set((await db.statement_imports.toArray()).map((i) => i.account_id)),
    [db],
  );
  const [checking, setChecking] = useState<BatchRow | null>(null);
  const history = useDocumentHistory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);

  const update = (id: string, change: Partial<BatchRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)));

  // One file at a time, in the order picked.
  useEffect(() => {
    if (reading.current || !accounts || !importedInto) return;
    const next = rows.find((r) => r.status === "waiting");
    if (!next) return;
    reading.current = true;
    update(next.id, { status: "reading" });
    void (async () => {
      try {
        const text = isPdf(next.file) ? "" : await readFileText(next.file);
        const read = isPdf(next.file)
          ? await readPdfForImport(new Uint8Array(await next.file.arrayBuffer()))
          : await readTextForImport(next.file.name, text);
        const sha = await fileSha256(next.file);
        const exact = await sameFile(db, sha);
        if ("total" in read) {
          const same = exact ?? (await sameTotal(db, read.total));
          update(next.id, {
            status: same ? "same" : "total",
            total: read.total,
            sha,
            same: same ? { id: same, was: "total" } : null,
            note: null,
          });
        } else if (read.parsed.rowCount === 0)
          // Nothing to check or import: say so instead of a Check that leads nowhere.
          update(next.id, { status: "refused", note: "Not read: no transactions found in it" });
        else
          update(next.id, {
            status: exact ? "same" : "statement",
            same: exact ? { id: exact, was: "statement" } : null,
            sha,
            parsed: read.parsed,
            text,
            account: accountFor(
              read.parsed,
              accounts,
              importedInto,
              entitlements.statement_accounts_max,
            ),
            note: null,
          });
      } catch (err) {
        update(next.id, { status: "refused", note: refusal(err) });
      } finally {
        reading.current = false;
        // A state change runs this again for the next one.
        setRows((rs) => [...rs]);
      }
    })();
  });

  const inBatch = rows.filter((r) => r.status !== "later" && r.status !== "too_big");
  const left = rows.filter((r) => r.status === "waiting" || r.status === "reading");
  const ready = rows.filter((r) => r.status === "total" || (r.status === "statement" && r.account));
  const toCheck = rows.filter((r) => r.status === "statement" && !r.account);
  const done = rows.filter((r) => r.status === "done");
  const sameRows = rows.filter((r) => r.status === "same");
  const finished = left.length === 0 && ready.length === 0 && toCheck.length === 0;
  const position = inBatch.findIndex((r) => r.status === "reading") + 1;
  const usedMb = inBatch.reduce((n, r) => n + r.file.size, 0);

  const word = left.length
    ? "Reading"
    : finished
      ? done.length
        ? "Done"
        : sameRows.length
          ? "Same"
          : "Review"
      : ready.length
        ? "Ready"
        : "Review";
  const line = left.length
    ? `File ${position || inBatch.length - left.length + 1} of ${inBatch.length} · on this device`
    : finished
      ? done.length
        ? `${done.length} ${done.length === 1 ? "file" : "files"} added.${rows.length > done.length ? ` ${rows.length - done.length} not added.` : ""}`
        : sameRows.length
          ? `${sameRows.length === 1 ? "It was" : "All of these were"} added before. Nothing new; Add anyway on a file to add it again.`
          : "Nothing could be added from these files."
      : `${inBatch.length - left.length} of ${inBatch.length} files read. Check each, or do all at once.`;

  async function doAll() {
    setBusy(true);
    setError(null);
    let failed = 0;
    for (const r of ready) {
      try {
        if (r.status === "total" && r.total) {
          await saveFromDocument(db, {
            kind: r.total.kind,
            group: r.total.group,
            label: r.total.label,
            value_cents: r.total.cents,
            as_of: r.total.as_of,
            file_name: r.file.name,
            file_sha256: r.sha ?? null,
          });
          update(r.id, { status: "done", note: totalLine(r) });
        } else if (r.account) {
          const { added, skipped } = await importReady(db, r);
          update(r.id, { status: "done", note: statementDone(added, skipped, r.account.label) });
        }
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed)
      setError(
        `${failed === 1 ? "1 file" : `${failed} files`} didn't finish. Nothing of ${failed === 1 ? "it" : "them"} was saved; check ${failed === 1 ? "it" : "each"} instead.`,
      );
  }

  const totals = ready.filter((r) => r.status === "total").length;
  const transactions = ready
    .filter((r) => r.status === "statement")
    .reduce((n, r) => n + (r.parsed?.rowCount ?? 0), 0);
  const plan = PLAN_NAME[entitlements.plan] ?? "Your plan";
  const over = limitsNote(rows, entitlements, plan);

  return (
    <>
      <Card as="section" aria-label="Your files" className="batch-head">
        <Word>{word}</Word>
        <p className="batch-head__line" role="status">
          {line}
        </p>
        {left.length ? (
          <>
            <div className="batch-head__bar" aria-hidden="true">
              <span
                style={{
                  width: `${Math.round(((inBatch.length - left.length) / Math.max(inBatch.length, 1)) * 100)}%`,
                }}
              />
            </div>
            <p className="batch-head__meta">
              {inBatch.length} files · {sizeOf(usedMb)} of {entitlements.import_batch_mb} MB · you
              can keep using the app
            </p>
          </>
        ) : null}
      </Card>

      {over ? (
        <p className="auth__error" role="alert">
          {over}{" "}
          {entitlements.plan !== "connected" && entitlements.plan !== "founding" ? (
            <Link to="/me/plan">See plans</Link>
          ) : null}
        </p>
      ) : null}

      <ol className="batch-list" aria-label="Files picked">
        {rows.map((r, i) => (
          <li key={r.id} className={`batch-row batch-row--${tone(r)}`}>
            <span className="batch-row__n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="batch-row__text">
              <span className="batch-row__name">
                <span className="sr-only">{i + 1}. </span>
                {maskFileName(r.file.name)}
              </span>
              <span className="batch-row__when">{whenOf(r)}</span>
              <span className="batch-row__what">{whatOf(r, history)}</span>
            </span>
            {r.status === "total" ? (
              <Button size="sm" variant="secondary" onClick={() => setChecking(r)}>
                Check
              </Button>
            ) : r.status === "statement" ? (
              <Button size="sm" variant="secondary" onClick={() => onCheckStatement(r)}>
                Check
              </Button>
            ) : r.status === "same" && r.same ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => update(r.id, { status: r.same?.was ?? "total", same: null })}
              >
                Add anyway
              </Button>
            ) : r.status === "refused" || r.status === "too_big" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}

      {left.length ? (
        <Button
          variant="secondary"
          block
          onClick={() =>
            setRows((rs) =>
              rs.map((r) =>
                r.status === "waiting" ? { ...r, status: "stopped", note: "Not read: stopped" } : r,
              ),
            )
          }
        >
          Stop reading
        </Button>
      ) : null}

      {!left.length && ready.length ? (
        <>
          <Button block disabled={busy} onClick={() => void doAll()}>
            Do all {ready.length}
          </Button>
          <p className="batch-note">
            {[
              totals ? `Adds ${totals} to Net worth` : null,
              transactions ? `imports ${transactions} transactions` : null,
            ]
              .filter(Boolean)
              .join(" and ")}
            .
            {toCheck.length ? ` ${toCheck.length} need a quick check first: pick the account.` : ""}{" "}
            Nothing is added until you tap.
          </p>
        </>
      ) : null}
      {!left.length && !ready.length && toCheck.length ? (
        <p className="batch-note">
          {toCheck.length === 1 ? "1 statement needs" : `${toCheck.length} statements need`} a quick
          check: tap Check to pick the account.
        </p>
      ) : null}

      {finished ? (
        <div className="batch-done">
          {done.length ? (
            <div className="batch-done__links">
              {done.some((r) => r.total) ? (
                <Link className={buttonClass({ block: true })} to="/net-worth">
                  Net worth
                </Link>
              ) : null}
              {done.some((r) => r.parsed) ? (
                <Link className={buttonClass({ block: true })} to="/money?view=transactions">
                  Money in &amp; out
                </Link>
              ) : null}
            </div>
          ) : null}
          <Button variant="secondary" block onClick={onAddMore}>
            Add more files
          </Button>
          <p className="batch-note">
            All of these are listed in{" "}
            <Link to="/me/documents">Me › Money &amp; data › Your documents</Link>.
          </p>
        </div>
      ) : null}

      <Sheet
        open={checking !== null}
        onClose={() => setChecking(null)}
        title={
          checking
            ? `File ${rows.findIndex((r) => r.id === checking.id) + 1} of ${rows.length}`
            : "Check"
        }
      >
        {checking?.total ? (
          <DocumentTotalCard
            total={checking.total}
            fileName={checking.file.name}
            fileSha={checking.sha ?? null}
            onSaved={() => {
              update(checking.id, { status: "done", note: totalLine(checking) });
              setChecking(null);
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function totalLine(r: BatchRow): string {
  const t = r.total;
  if (!t) return "Added";
  return `${t.label}, ${formatCents(t.cents)}${t.kind === "debt" ? " owed" : ""} → Net worth`;
}

export function statementDone(added: number, skipped: number, account: string): string {
  return `${added} ${added === 1 ? "transaction" : "transactions"} → ${account}${skipped ? ` · ${skipped} already here, skipped` : ""}`;
}

function tone(r: BatchRow): "read" | "now" | "wait" | "warn" | "done" {
  if (r.status === "done" || r.status === "total" || r.status === "statement")
    return r.status === "done" ? "done" : "read";
  if (r.status === "reading") return "now";
  if (r.status === "refused" || r.status === "too_big") return "warn";
  return "wait";
}

/** The date the document gives, else the day the file was saved, and its size. */
function whenOf(r: BatchRow): string {
  const size = sizeOf(r.file.size);
  if (r.total?.as_of) return `As of ${formatDate(r.total.as_of)} · ${size}`;
  const period = r.parsed?.ofx?.period ?? r.parsed?.pdf?.period;
  if (period?.start && period.end)
    return `${formatDate(period.start)} – ${formatDate(period.end)} · ${size}`;
  const saved = r.file.lastModified ? new Date(r.file.lastModified) : null;
  if (saved) {
    const iso = `${saved.getFullYear()}-${String(saved.getMonth() + 1).padStart(2, "0")}-${String(saved.getDate()).padStart(2, "0")}`;
    return `Saved ${formatDate(iso)} · ${size}`;
  }
  return size;
}

function whatOf(r: BatchRow, history: DocRow[] | undefined): string {
  switch (r.status) {
    case "same": {
      const earlier = history?.find((h) => h.id === r.same?.id);
      return earlier
        ? `Same as added ${earlier.added} · ${earlier.became} · Do all skips it`
        : "Added before · Do all skips it";
    }
    case "waiting":
      return "Waiting";
    case "reading":
      return "Reading…";
    case "total": {
      const t = r.total;
      return t
        ? `Found · ${t.label} · ${formatCents(t.cents)}${t.kind === "debt" ? " owed" : ""} · ${GROUP_LABEL[t.group] ?? t.group}`
        : "Found";
    }
    case "statement": {
      // The dates are on the line above; here what it holds and where it goes.
      const p = r.parsed;
      if (!p) return "Statement";
      const last4 = p.ofx?.account.last4 ?? p.pdf?.account.last4 ?? null;
      const what =
        p.format === "csv"
          ? fileSummary(p)
          : `Statement · ${p.rowCount} ${p.rowCount === 1 ? "transaction" : "transactions"}${last4 ? ` · ••${last4}` : ""}`;
      return `${what} · ${r.account ? `into ${r.account.label}` : "check to pick the account"}`;
    }
    default:
      return r.note ?? "";
  }
}
