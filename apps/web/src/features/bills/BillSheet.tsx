import "../auth/auth.css";
import "../entries/entries.css";

import { Button, Sheet } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { RecurringInterval, RecurringKind, RecurringSeries } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { todayIso } from "../../lib/format.ts";
import {
  addSeries,
  INTERVAL_LABELS,
  removeSeries,
  updateSeries,
} from "../forecast/useRecurring.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";

/** Add or edit a bill or expected income by hand (spec: "Users can also add bills and expected income by hand"). */
export function BillSheet({
  open,
  series,
  onClose,
}: {
  open: boolean;
  series: RecurringSeries | null;
  onClose: () => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<RecurringKind>("bill");
  const [interval, setInterval] = useState<RecurringInterval>("monthly");
  const [nextDate, setNextDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(series?.label ?? "");
    setAmount(series ? (series.expected_cents / 100).toFixed(2) : "");
    setKind(series?.kind ?? "bill");
    setInterval(series?.interval ?? "monthly");
    setNextDate(series?.next_date ?? "");
    setError(null);
    setConfirmRemove(false);
  }, [open, series]);

  async function save() {
    setError(null);
    if (!label.trim()) {
      setError("Give it a name.");
      return;
    }
    let cents: number;
    try {
      cents = await parseAmount(amount);
    } catch {
      setError("Enter an amount like 45.00.");
      return;
    }
    if (cents <= 0) {
      setError("Enter an amount above zero.");
      return;
    }
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(nextDate) || nextDate < today) {
      setError("Pick the next date, today or later.");
      return;
    }
    const draft = { label, kind, expected_cents: cents, interval, next_date: nextDate };
    if (series) await updateSeries(db, series.id, draft);
    else await addSeries(db, draft);
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={series ? "Edit" : "Add a bill or income"}>
      <label className="auth__field">
        <span className="auth__label">Name</span>
        <input
          className="auth__input"
          placeholder="e.g. Car insurance"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">Amount</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="180.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0" }}>
        <legend className="auth__label">What is it?</legend>
        <ChoiceChips
          name={`${ids}-kind`}
          options={[
            ["bill", "A bill"],
            ["income", "Income"],
          ]}
          value={kind}
          onPick={(v) => setKind(v as RecurringKind)}
        />
      </fieldset>
      <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0" }}>
        <legend className="auth__label">How often</legend>
        <ChoiceChips
          name={`${ids}-interval`}
          options={(Object.keys(INTERVAL_LABELS) as RecurringInterval[]).map((k) => [
            k,
            INTERVAL_LABELS[k],
          ])}
          value={interval}
          onPick={(v) => setInterval(v as RecurringInterval)}
        />
      </fieldset>
      <label className="auth__field">
        <span className="auth__label">Next date</span>
        <input
          className="auth__input"
          type="date"
          min={today}
          value={nextDate}
          onChange={(e) => setNextDate(e.target.value)}
        />
      </label>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={save}>
        {series ? "Save" : "Add"}
      </Button>
      {series ? (
        <Button
          block
          variant="ghost"
          onClick={async () => {
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            await removeSeries(db, series.id);
            onClose();
          }}
        >
          <span style={{ color: "var(--c-danger)" }}>
            {confirmRemove ? "Really remove" : "Remove"}
          </span>
        </Button>
      ) : null}
    </Sheet>
  );
}
