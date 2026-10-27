import { Button, List, ListRow, Toggle } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import type { Account, CsvMapping, DateFormat, SignConvention } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { applyMapping, type CsvTable, type MappedRow } from "../../importers/csv.ts";
import { formatCents, formatDay } from "../../lib/format.ts";

const FIELDS: Array<
  [
    keyof Pick<CsvMapping, "date" | "description" | "amount" | "debit" | "credit" | "balance">,
    string,
    boolean,
  ]
> = [
  ["date", "Date", true],
  ["description", "Description", true],
  ["amount", "Amount", false],
  ["debit", "Money out", false],
  ["credit", "Money in", false],
  ["balance", "Balance (optional)", false],
];

/** Step 2 of 3 (mockup F3Map), CSV only: check the guessed columns once; remembered per account. */
export function ColumnMapper({
  fileName,
  account,
  table,
  mapping,
  remember,
  onChange,
  onRemember,
  onNext,
}: {
  fileName: string;
  account: Account;
  table: CsvTable;
  mapping: CsvMapping;
  remember: boolean;
  onChange: (m: CsvMapping) => void;
  onRemember: (on: boolean) => void;
  onNext: () => void;
}) {
  const ids = useId();
  const [preview, setPreview] = useState<MappedRow[]>([]);
  const [skipped, setSkipped] = useState(0);
  const twoColumns = mapping.amount === null;

  useEffect(() => {
    let alive = true;
    const sample: CsvTable = { ...table, rows: table.rows.slice(0, 4) };
    void applyMapping(sample, mapping, parseAmount).then((r) => {
      if (alive) {
        setPreview(r.rows);
        setSkipped(r.skipped.length);
      }
    });
    return () => {
      alive = false;
    };
  }, [table, mapping]);

  const set = (patch: Partial<CsvMapping>) => onChange({ ...mapping, ...patch });
  const visibleFields = FIELDS.filter(([f]) =>
    twoColumns ? f !== "amount" : f !== "debit" && f !== "credit",
  );

  return (
    <>
      <p className="auth__lead">
        {fileName} · {account.label}. We guessed these — check them once and we'll remember for this
        account.
      </p>
      <div className="fields">
        {visibleFields.map(([field, label, required]) => (
          <div className="map-row" key={field}>
            <label htmlFor={`${ids}-${field}`}>{label}</label>
            <span className="map-row__arrow" aria-hidden="true">
              →
            </span>
            <select
              id={`${ids}-${field}`}
              value={mapping[field] ?? ""}
              onChange={(e) =>
                set({
                  [field]: e.target.value === "" ? null : Number(e.target.value),
                } as Partial<CsvMapping>)
              }
            >
              {required ? null : <option value="">Not in this file</option>}
              {table.headers.map((h, i) => (
                <option key={`${ids}-${field}-${h}`} value={i}>
                  {h || `Column ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="map-meta">
          {twoColumns ? (
            <button
              type="button"
              className="auth__link"
              onClick={() => set({ amount: firstFree(mapping, table), debit: null, credit: null })}
            >
              My file has one amount column
            </button>
          ) : (
            <>
              <label>
                Amounts:
                <select
                  value={mapping.sign}
                  onChange={(e) => set({ sign: e.target.value as SignConvention })}
                  aria-label="Sign convention"
                >
                  <option value="negative_out">negative = money out</option>
                  <option value="negative_in">negative = money in</option>
                </select>
              </label>
              <button
                type="button"
                className="auth__link"
                onClick={() => set({ amount: null, debit: mapping.amount, credit: null })}
              >
                Two columns (money out / in)
              </button>
            </>
          )}
          <label>
            Dates:
            <select
              value={mapping.date_format}
              onChange={(e) => set({ date_format: e.target.value as DateFormat })}
              aria-label="Date format"
            >
              <option value="MDY">MM/DD/YYYY</option>
              <option value="DMY">DD/MM/YYYY</option>
              <option value="YMD">YYYY-MM-DD</option>
            </select>
          </label>
        </div>
      </div>
      <h2 className="section-title">Preview</h2>
      <List card aria-label="Preview of the first rows">
        {preview.map((r) => (
          <ListRow
            key={r.row}
            leading={<span className="sk-row__sublabel">{formatDay(r.date)}</span>}
            label={r.description}
            value={formatCents(r.amount_cents, r.amount_cents < 0 ? "out" : "in")}
            valueTone={r.amount_cents < 0 ? "default" : "success"}
          />
        ))}
        {preview.length === 0 ? (
          <ListRow label="Nothing readable yet. Check the Date and Amount columns." />
        ) : null}
      </List>
      {skipped > 0 ? (
        <p className="auth__hint">
          {skipped} of the first rows couldn't be read with these settings.
        </p>
      ) : null}
      <Toggle
        label={`Remember this for ${account.label}`}
        checked={remember}
        onChange={onRemember}
      />
      <Button block onClick={onNext} disabled={preview.length === 0}>
        Looks right
      </Button>
      <p className="auth__fineprint">OFX and QFX files skip this step.</p>
    </>
  );
}

function firstFree(mapping: CsvMapping, table: CsvTable): number {
  const used = new Set([mapping.date, mapping.description, mapping.balance ?? -1]);
  const free = table.headers.findIndex((_, i) => !used.has(i));
  return free === -1 ? 0 : free;
}
