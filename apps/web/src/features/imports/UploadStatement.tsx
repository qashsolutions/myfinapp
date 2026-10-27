import { Button } from "@stackd/ui";
import { useId, useState } from "react";
import type { Account } from "../../data/db.ts";
import { readFileText } from "../../data/files.ts";
import { PdfError } from "../../importers/pdf/index.ts";
import { AccountPicker, type AccountSuggestion } from "./AccountPicker.tsx";
import { type ParsedFile, parseFile, parsePdfFile } from "./importFlow.ts";

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
}: {
  chosen: Chosen | null;
  account: Account | null;
  onFile: (c: Chosen | null) => void;
  onAccount: (a: Account) => void;
  onNext: () => void;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        onFile({ file, text: "", parsed: await parsePdfFile(bytes) });
        return;
      }
      const text = await readFileText(file);
      onFile({ file, text, parsed: await parseFile(file.name, text) });
    } catch (err) {
      onFile(null);
      setError(
        err instanceof PdfError
          ? err.code === "no_text"
            ? "This PDF has no text we can read (a scanned image, perhaps). Download a CSV, OFX or QFX from your bank instead."
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
            ? `${chosen.file.name} · ${chosen.parsed.rowCount} rows`
            : "Choose a statement file"}
        </span>
        <span className="dropzone__sub">
          CSV, OFX, QFX or a PDF statement from your bank or card
        </span>
        <input
          id={id}
          type="file"
          accept=".csv,.ofx,.qfx,.pdf"
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </label>
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
        Read on this device. The file is never uploaded.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <AccountPicker
        value={account?.id ?? null}
        onChange={onAccount}
        suggest={suggestionFor(chosen)}
      />
      <div className="auth__spacer" />
      <Button block onClick={onNext} disabled={!chosen || !account}>
        Read file
      </Button>
      <p className="auth__fineprint">
        PDF statements are read from their text: the common "date, description, amount, balance"
        layout works; scanned images don't. If yours doesn't read, download a CSV or OFX instead.
      </p>
    </>
  );
}
