import "../auth/auth.css";
import { ENTRIES_PATH } from "../entries/paths.ts";
import "../entries/entries.css";
import "./imports.css";

import { useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Account, CsvMapping } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { applyMapping } from "../../importers/csv.ts";
import { ColumnMapper } from "./ColumnMapper.tsx";
import { ImportPreview } from "./ImportPreview.tsx";
import {
  commitImport,
  mappingFor,
  type Prepared,
  pdfForAccount,
  prepareRows,
} from "./importFlow.ts";
import { type Chosen, UploadStatement } from "./UploadStatement.tsx";

type Step = 1 | 2 | 3;
const TITLES: Record<Step, string> = {
  1: "Import a statement",
  2: "Match columns",
  3: "Review import",
};

/** The three steps: file + account → (CSV) match columns → review and import. All on the device. */
export function ImportFlow() {
  const { db } = useDb();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [remember, setRemember] = useState(true);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [transfers, setTransfers] = useState<Set<string>>(new Set());
  const [keepFile, setKeepFile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readFile() {
    if (!chosen || !account) return;
    setError(null);
    if (chosen.parsed.format === "csv" && chosen.parsed.csv) {
      const { mapping: m } = await mappingFor(db, account.id, chosen.parsed.csv);
      setMapping(m);
      setStep(2);
      return;
    }
    if (chosen.parsed.ofx) {
      const ofx = chosen.parsed.ofx;
      if (!account.last4 && ofx.account.last4) {
        await db.accounts.update(account.id, {
          last4: ofx.account.last4,
          institution: account.institution ?? ofx.account.institution,
        });
        setAccount({ ...account, last4: ofx.account.last4 });
      }
      await review(await prepareRows(db, account.id, ofx.rows, ofx.ledger));
      return;
    }
    const pdf = await pdfForAccount(chosen.parsed, account.type);
    if (pdf) {
      if (!account.last4 && pdf.account.last4) {
        await db.accounts.update(account.id, {
          last4: pdf.account.last4,
          institution: account.institution ?? pdf.institution,
        });
        setAccount({ ...account, last4: pdf.account.last4 });
      }
      await review(await prepareRows(db, account.id, pdf.rows, pdf.ledger));
    }
  }

  async function review(p: Prepared) {
    setPrepared(p);
    setTransfers(
      new Set(
        p.rows
          .filter((r) => !r.duplicate && (r.is_transfer_hint || r.match))
          .map((r) => r.fingerprint),
      ),
    );
    setStep(3);
  }

  async function looksRight() {
    if (!chosen?.parsed.csv || !mapping || !account) return;
    const { rows } = await applyMapping(chosen.parsed.csv, mapping, parseAmount);
    await review(await prepareRows(db, account.id, rows));
  }

  async function doImport() {
    if (!prepared || !account || !chosen) return;
    setBusy(true);
    try {
      await commitImport(db, {
        account,
        format: chosen.parsed.format,
        fileName: chosen.file.name,
        prepared,
        transfers,
        mapping: mapping ?? undefined,
        rememberMapping: remember,
        file: chosen.file,
        keepFile,
        period: chosen.parsed.ofx?.period ?? chosen.parsed.pdf?.period,
        templateKey: chosen.parsed.pdf?.template_key ?? null,
      });
      navigate(ENTRIES_PATH, { replace: true });
    } catch {
      setError("The import didn't finish. Nothing was saved; try again.");
    } finally {
      setBusy(false);
    }
  }

  const back = step === 1 ? "/" : undefined;
  return (
    <>
      <ScreenHeader
        title={TITLES[step]}
        back={back}
        actions={<span className="import-step">{step} of 3</span>}
      />
      {step > 1 ? (
        <button
          type="button"
          className="auth__link"
          onClick={() => setStep((s) => (s === 3 && chosen?.parsed.format === "csv" ? 2 : 1))}
        >
          ‹ Back
        </button>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {step === 1 ? (
        <UploadStatement
          chosen={chosen}
          account={account}
          onFile={setChosen}
          onAccount={setAccount}
          onNext={readFile}
        />
      ) : null}
      {step === 2 && chosen?.parsed.csv && mapping && account ? (
        <ColumnMapper
          fileName={chosen.file.name}
          account={account}
          table={chosen.parsed.csv}
          mapping={mapping}
          remember={remember}
          onChange={setMapping}
          onRemember={setRemember}
          onNext={looksRight}
        />
      ) : null}
      {step === 3 && prepared && account && chosen ? (
        <ImportPreview
          account={account}
          format={chosen.parsed.format}
          prepared={prepared}
          pdfCheck={
            chosen.parsed.pdf
              ? { skipped: chosen.parsed.pdf.skipped, reconciles: chosen.parsed.pdf.reconciles }
              : null
          }
          transfers={transfers}
          keepFile={keepFile}
          busy={busy}
          onTransfer={(fp, yes) =>
            setTransfers((prev) => {
              const next = new Set(prev);
              if (yes) next.add(fp);
              else next.delete(fp);
              return next;
            })
          }
          onKeepFile={setKeepFile}
          onImport={doImport}
        />
      ) : null}
    </>
  );
}
