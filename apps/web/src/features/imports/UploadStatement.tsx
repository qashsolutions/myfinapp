import { Button } from "@stackd/ui";
import { useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Account } from "../../data/db.ts";
import { readFileText } from "../../data/files.ts";
import { maskFileName } from "../../importers/masking.ts";
import { PdfError } from "../../importers/pdf/index.ts";
import type { DocumentTotal } from "../../importers/totals.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { AccountPicker, type AccountSuggestion } from "./AccountPicker.tsx";
import { AddedBefore } from "./AddedBefore.tsx";
import { MB, sizeOf } from "./batch.ts";
import { DocumentTotalCard } from "./DocumentTotalCard.tsx";
import { useDocumentHistory } from "./documentHistory.ts";
import { fileSummary } from "./fileSummary.ts";
import { type ParsedFile, readPdfForImport, readTextForImport } from "./importFlow.ts";

/** What the statement says about its account, for a one-tap "New account" (OFX and PDF). */
function suggestionFor(chosen: Chosen | null): AccountSuggestion | null {
  const info = chosen?.parsed.ofx
    ? { ...chosen.parsed.ofx.account }
    : chosen?.parsed.pdf
      ? { ...chosen.parsed.pdf.account, institution: chosen.parsed.pdf.institution }
      : null;
  if (!info?.last4) return null;
  return { last4: info.last4, type: info.type ?? null, institution: info.institution ?? null };
}

export interface Chosen {
  file: File;
  text: string;
  parsed: ParsedFile;
}

/** Step 1 of 3 (mockup F3Import): the file, read on this device, and the account it belongs to. */
export function UploadStatement({
  chosen,
  account,
  onFile,
  onAccount,
  onNext,
  onBatch,
}: {
  chosen: Chosen | null;
  account: Account | null;
  onFile: (c: Chosen | null) => void;
  onAccount: (a: Account) => void;
  onNext: () => void;
  /** Two or more files picked together (November 16, 2026): they go to the batch list. */
  onBatch?: (files: File[]) => void;
}) {
  const { entitlements } = useEntitlements();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  // A brokerage's positions page: nothing to import, but its total belongs in Net worth.
  const [holdings, setHoldings] = useState(false);
  // The file picked last, kept on screen even when it couldn't be read, so it's clear which one.
  const [refused, setRefused] = useState<string | null>(null);
  // A document with a total for Net worth (an investment account, a loan), and its file's name.
  const [found, setFound] = useState<{ name: string; total: DocumentTotal } | null>(null);
  const navigate = useNavigate();
  const history = useDocumentHistory();
  // The same file added before (matched on its masked name, which is all that is kept).
  const current = chosen?.file.name ?? found?.name ?? null;
  const before = current ? history?.find((r) => r.name === maskFileName(current)) : undefined;
  // Never a dead button: Read file stays tappable and says what's missing first.
  const [missing, setMissing] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accounts = useRef<HTMLDivElement>(null);

  function next() {
    if (!chosen) {
      setMissing("Choose a statement file first.");
      fileInput.current?.focus();
      return;
    }
    if (!account) {
      setMissing("Pick which account this is.");
      accounts.current?.querySelector<HTMLElement>("input:not(:disabled), button")?.focus();
      return;
    }
    onNext();
  }

  async function pickAll(list: FileList | null) {
    const files = [...(list ?? [])];
    if (files.length > 1 && onBatch) {
      onBatch(files);
      return;
    }
    await pick(files[0]);
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    // The plan's per-file size (plans.yaml import_file_mb).
    if (file.size > entitlements.import_file_mb * MB) {
      onFile(null);
      setFound(null);
      setHoldings(false);
      setRefused(file.name);
      setError(
        `This file is ${sizeOf(file.size)}; files can be up to ${entitlements.import_file_mb} MB. Download one month or a CSV instead.`,
      );
      return;
    }
    setError(null);
    setHoldings(false);
    setRefused(null);
    setFound(null);
    setMissing(null);
    try {
      const pdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
      const text = pdf ? "" : await readFileText(file);
      const read = pdf
        ? await readPdfForImport(new Uint8Array(await file.arrayBuffer()))
        : await readTextForImport(file.name, text);
      if ("total" in read) {
        onFile(null);
        setFound({ name: file.name, total: read.total });
        return;
      }
      onFile({ file, text, parsed: read.parsed });
    } catch (err) {
      onFile(null);
      setRefused(file.name);
      const isHoldings = err instanceof PdfError && err.code === "holdings";
      setHoldings(isHoldings);
      setError(
        err instanceof PdfError
          ? err.code === "no_text"
            ? "This PDF has no text we can read (a scanned image, perhaps). Download a CSV, OFX or QFX from your bank instead."
            : isHoldings
              ? "This lists investments you own (positions), not money in and out, so there's nothing to import. Qash reads bank and card statements. To count this account, add its total in Net worth."
              : "We couldn't find transactions in this PDF's layout. Download a CSV, OFX or QFX from your bank instead."
          : "We couldn't read that file. Export a CSV, OFX or QFX from your bank and try again.",
      );
    }
  }

  return (
    <>
      <label className="dropzone" htmlFor={id}>
        <span className="dropzone__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 16V5M7 10l5-5 5 5M5 19h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="dropzone__title">
          {chosen
            ? maskFileName(chosen.file.name)
            : found
              ? maskFileName(found.name)
              : refused
                ? maskFileName(refused)
                : "Choose a statement file"}
        </span>
        <span className="dropzone__sub">
          {chosen
            ? fileSummary(chosen.parsed)
            : found
              ? found.total.kind === "debt"
                ? "Loan statement · balance owed found · for Net worth"
                : "Investment account · total found · for Net worth"
              : refused
                ? holdings
                  ? "Investment holdings, not transactions · not imported"
                  : "Not imported · choose another file"
                : "Pick one or several: statements, and investment or loan documents"}
        </span>
        <input
          ref={fileInput}
          id={id}
          type="file"
          accept=".csv,.ofx,.qfx,.pdf"
          multiple
          onChange={(e) => void pickAll(e.target.files)}
        />
      </label>
      {!chosen && !found ? (
        <p className="import-limits">
          Up to {entitlements.import_files_max}{" "}
          {entitlements.import_files_max === 1 ? "file" : "files"} at a time,{" "}
          {entitlements.import_file_mb} MB each, {entitlements.import_batch_mb} MB in all · CSV,
          OFX, QFX or PDF
        </p>
      ) : null}
      <p className="import-note">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 3h8a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2zm3 15h2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        Read on this device, one file at a time. Never uploaded.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
          {holdings ? (
            <>
              {" "}
              <Link to="/net-worth">Open Net worth</Link>
            </>
          ) : null}
        </p>
      ) : null}
      {before ? (
        <p className="import-seen" role="status">
          Added before, on {before.added}: {before.became}.{" "}
          {found
            ? "Adding it again updates that line, never a second one unless you choose."
            : "Importing it again skips what's already in Qash, so nothing counts twice."}
        </p>
      ) : null}
      {found ? (
        <DocumentTotalCard
          key={found.name}
          total={found.total}
          fileName={found.name}
          onSaved={(id) => navigate("/net-worth", { state: { highlight: `worth-manual:${id}` } })}
        />
      ) : null}
      <div ref={accounts} hidden={found !== null}>
        <AccountPicker
          value={account?.id ?? null}
          onChange={(a) => {
            setMissing(null);
            onAccount(a);
          }}
          suggest={suggestionFor(chosen)}
          onStartNew={() => setMissing(null)}
        />
      </div>
      <div className="auth__spacer" />
      {missing ? (
        <p className="auth__error" role="alert">
          {missing}
        </p>
      ) : null}
      {found ? null : (
        <Button block onClick={next}>
          Read file
        </Button>
      )}
      <p className="auth__fineprint">
        PDFs: text statements work, scans don't. If yours won't read, use CSV or OFX.
      </p>
      {!chosen && !found && history ? <AddedBefore rows={history} /> : null}
    </>
  );
}
