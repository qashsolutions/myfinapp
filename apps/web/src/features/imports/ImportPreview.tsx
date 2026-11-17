import { Button, Card, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useDb } from "../../data/DbProvider.tsx";
import type { Account, ImportFormat } from "../../data/db.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { ENTRIES_PATH } from "../entries/paths.ts";
import { AlreadyAdded } from "./AlreadyAdded.tsx";
import { useDocumentHistory } from "./documentHistory.ts";
import { lastStatementInto } from "./duplicates.ts";
import type { Prepared } from "./importFlow.ts";
import { TransferReview } from "./TransferReview.tsx";

/** Step 3 of 3 (mockup F3Review): what was found, what is new, transfers, and the import button. */
export function ImportPreview({
  account,
  format,
  prepared,
  transfers,
  keepFile,
  busy,
  onTransfer,
  onKeepFile,
  onImport,
  pdfCheck = null,
}: {
  account: Account;
  format: ImportFormat;
  /** A PDF statement's own check (October 22, 2026): lines it couldn't read, whether rows add up. */
  pdfCheck?: { skipped: number; reconciles: boolean | null } | null;
  prepared: Prepared;
  transfers: Set<string>;
  keepFile: boolean;
  busy: boolean;
  onTransfer: (fingerprint: string, isTransfer: boolean) => void;
  onKeepFile: (on: boolean) => void;
  onImport: () => void;
}) {
  const hinted = prepared.rows.filter((r) => !r.duplicate && (r.is_transfer_hint || r.match));
  const { db } = useDb();
  const navigate = useNavigate();
  const history = useDocumentHistory();
  // Every transaction already in Qash: the statement this repeats, until Add it anyway.
  const nothingNew = prepared.fresh === 0 && prepared.found > 0;
  const lastId = useLiveQuery(
    () => (nothingNew ? lastStatementInto(db, account.id) : null),
    [db, account.id, nothingNew],
  );
  const earlier = lastId ? history?.find((r) => r.id === lastId) : undefined;
  const [anyway, setAnyway] = useState(false);
  if (nothingNew && earlier && !anyway)
    return (
      <AlreadyAdded
        earlier={earlier}
        why={`Every one of its ${prepared.found} ${prepared.found === 1 ? "transaction" : "transactions"} is already in Qash. The last statement for ${account.label}`}
        anywayNote="Adding it anyway only lists the file in Your documents; no transaction is added twice."
        onKeep={() => navigate(ENTRIES_PATH)}
        onAnyway={() => setAnyway(true)}
      />
    );
  return (
    <>
      <fieldset className="stats">
        <legend className="sr-only">Rows</legend>
        <div className="stat">
          <span className="stat__n">{prepared.found}</span>
          <span className="stat__l">rows found</span>
        </div>
        <div className="stat">
          <span className="stat__n stat__n--good">{prepared.fresh}</span>
          <span className="stat__l">new</span>
        </div>
        <div className="stat">
          <span className="stat__n">{prepared.duplicates}</span>
          <span className="stat__l">already in Qash · skipped</span>
        </div>
      </fieldset>
      {pdfCheck ? (
        <p
          className={
            pdfCheck.reconciles === false || pdfCheck.skipped > 0 ? "auth__error" : "auth__hint"
          }
          role="note"
        >
          {pdfCheck.reconciles === true
            ? "Read from a PDF. The rows add up to your statement's ending balance."
            : pdfCheck.reconciles === false
              ? "Read from a PDF, and the rows don't add up to your statement's ending balance: a line may be missing or read the wrong way round. Check them against your statement, or download a CSV, OFX or QFX from your bank instead."
              : "Read from a PDF. Check a few rows against your statement; a CSV, OFX or QFX from your bank is the surest."}
          {pdfCheck.skipped > 0
            ? ` ${pdfCheck.skipped} ${pdfCheck.skipped === 1 ? "line that looked like a transaction" : "lines that looked like transactions"} couldn't be read.`
            : ""}
        </p>
      ) : null}
      <TransferReview rows={hinted} transfers={transfers} onChange={onTransfer} />
      <Card as="section" aria-label="Summary">
        <div className="summary-row">
          <span>Categorized automatically</span>
          <strong>{prepared.categorized}</strong>
        </div>
        <div className={`summary-row${prepared.uncategorized ? " summary-row--warn" : ""}`}>
          <span>Need a category</span>
          <strong>
            {prepared.uncategorized ? `${prepared.uncategorized} · review after` : "0"}
          </strong>
        </div>
        {prepared.ending_balance ? (
          <div className="summary-row">
            <span>Ending balance ({formatDay(prepared.ending_balance.as_of)})</span>
            <strong>{formatCents(prepared.ending_balance.cents)}</strong>
          </div>
        ) : null}
      </Card>
      <Toggle
        label="Keep a copy of the file on this device"
        checked={keepFile}
        onChange={onKeepFile}
      />
      <Button block onClick={onImport} disabled={busy}>
        {prepared.fresh === 0
          ? "Add it to Your documents"
          : `Import ${prepared.fresh} ${prepared.fresh === 1 ? "transaction" : "transactions"}`}
      </Button>
      <p className="auth__fineprint">
        {account.last4 ? `Account number masked to ••${account.last4}. ` : ""}
        The {format === "csv" ? "file" : "statement"} stays on this device.
      </p>
    </>
  );
}
