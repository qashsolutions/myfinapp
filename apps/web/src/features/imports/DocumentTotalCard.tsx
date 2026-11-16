import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useId, useRef, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { parseAmount } from "../../engine/bridge.ts";
import type { DocumentTotal } from "../../importers/totals.ts";
import { formatCents, formatDate, todayIso } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import {
  ASSET_GROUPS,
  DEBT_GROUPS,
  GROUP_LABEL,
  sameItems,
  saveFromDocument,
} from "../networth/useNetWorth.ts";

/**
 * An investment, retirement, HSA, loan or mortgage document (November 16, 2026): one card with
 * the total it found, for Net worth. The person checks the name, amount, date and kind first;
 * only those are kept, never the file, the account number or the holdings.
 */
export function DocumentTotalCard({
  total,
  onSaved,
}: {
  total: DocumentTotal;
  onSaved: (itemId: string) => void;
}) {
  const ids = useId();
  const { db } = useDb();
  const items = useLiveQuery(() => db.net_worth_items.toArray(), [db]);
  const [label, setLabel] = useState(total.label);
  const [amount, setAmount] = useState((total.cents / 100).toFixed(2));
  const [asOf, setAsOf] = useState(total.as_of ?? todayIso());
  const [group, setGroup] = useState(total.group);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);
  const amountBox = useRef<HTMLInputElement>(null);
  const matches = sameItems(items ?? [], { kind: total.kind, label });
  const owed = total.kind === "debt";

  async function save(updateId?: string) {
    const name = label.trim();
    if (!name) {
      setError("Give it a name, like “Rollover IRA” or “Mortgage”.");
      nameBox.current?.focus();
      return;
    }
    let cents: number;
    try {
      cents = await parseAmount(amount);
    } catch {
      setError("Enter an amount like 12,500.00.");
      amountBox.current?.focus();
      return;
    }
    if (cents <= 0) {
      setError("Enter an amount above $0.");
      amountBox.current?.focus();
      return;
    }
    setBusy(true);
    const id = await saveFromDocument(db, {
      id: updateId,
      kind: total.kind,
      group,
      label: name.slice(0, 30),
      value_cents: cents,
      as_of: asOf || null,
    });
    onSaved(id);
  }

  const groups = owed ? DEBT_GROUPS : ASSET_GROUPS;
  return (
    <Card as="section" aria-label="Found in this document" className="doc-total">
      <Word>Found</Word>
      <p className="doc-total__line">
        {owed ? "A balance owed" : "An account's total"} of{" "}
        <strong>{formatCents(total.cents)}</strong>
        {total.as_of ? ` as of ${formatDate(total.as_of)}` : ""}. Check it, then add it to Net
        worth.
      </p>
      <label className="auth__field">
        <span className="auth__label">Name</span>
        <input
          ref={nameBox}
          className="auth__input"
          maxLength={30}
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">{owed ? "Amount owed" : "What it's worth"}</span>
        <input
          ref={amountBox}
          className="auth__input"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">As of</span>
        <input
          className="auth__input"
          type="date"
          value={asOf}
          max={todayIso()}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </label>
      <span className="auth__label" id={`${ids}-kind`}>
        What is it?
      </span>
      <ChoiceChips
        name={`${ids}-group`}
        options={groups.map(([k, l]) => [k, l])}
        value={group}
        onPick={(v) => setGroup(v)}
      />
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {matches[0] ? (
        <div className="doc-total__actions">
          <Button block disabled={busy} onClick={() => void save(matches[0]?.id)}>
            Update “{matches[0].label}”
          </Button>
          <Button block variant="secondary" disabled={busy} onClick={() => void save()}>
            Add as new
          </Button>
        </div>
      ) : (
        <Button block disabled={busy} onClick={() => void save()}>
          Add to Net worth
        </Button>
      )}
      <p className="auth__fineprint">
        Only the name, amount, date and kind ({GROUP_LABEL[group] ?? group}) are kept, on this
        device. Not the file, the account number or the holdings.
      </p>
    </Card>
  );
}
