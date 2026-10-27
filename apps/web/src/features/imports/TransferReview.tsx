import { Button, Card } from "@stackd/ui";
import { formatCents, formatDay } from "../../lib/format.ts";
import { accountLabel, useLookups } from "../entries/useEntries.ts";
import type { PreparedRow } from "./importFlow.ts";

/**
 * "Is this a transfer?" for rows the keyword table flags (mockup F3Review). Transfers between
 * the user's own accounts are not money in or out. Matching the other side of a transfer
 * across accounts is chunk 1.3c (cashflow.py).
 */
export function TransferReview({
  rows,
  transfers,
  onChange,
}: {
  rows: PreparedRow[];
  transfers: Set<string>;
  onChange: (fingerprint: string, isTransfer: boolean) => void;
}) {
  const lookups = useLookups();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="transfers-h">
      <h2 className="section-title" id="transfers-h">
        Is this a transfer?
      </h2>
      <p className="auth__hint" style={{ margin: "0 4px 8px" }}>
        Transfers between your own accounts aren't counted as money in or out.
      </p>
      {rows.map((r) => {
        const yes = transfers.has(r.fingerprint);
        return (
          <Card key={r.fingerprint} as="section" aria-label={r.description}>
            <div className="summary-row" style={{ minHeight: 0 }}>
              <span className="sk-row__label">{r.description}</span>
              <strong>{formatCents(r.abs_cents, r.direction)}</strong>
            </div>
            <p className="sk-card__eyebrow">
              {formatDay(r.date)} ·{" "}
              {r.match
                ? `matches ${formatCents(r.match.amount_cents, r.match.direction)} on ${accountLabel(lookups?.accounts.get(r.match.account_id)) || "another account"}`
                : "no matching entry in another account yet"}
            </p>
            <fieldset className="transfer-choice">
              <legend className="sr-only">{`${r.description}: transfer?`}</legend>
              <Button
                variant={yes ? "primary" : "secondary"}
                aria-pressed={yes}
                onClick={() => onChange(r.fingerprint, true)}
              >
                {yes ? <span aria-hidden="true">✓ </span> : null}Yes, transfer
              </Button>
              <Button
                variant={yes ? "secondary" : "primary"}
                aria-pressed={!yes}
                onClick={() => onChange(r.fingerprint, false)}
              >
                {yes ? null : <span aria-hidden="true">✓ </span>}
                {r.direction === "in" ? "No, income" : "No, spending"}
              </Button>
            </fieldset>
          </Card>
        );
      })}
    </section>
  );
}
