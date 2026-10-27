import "../auth/auth.css";

import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type Debt, newId } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";

/** Add or edit a card or loan: label, balance, APR, minimum payment. Nothing is moved. */
export function DebtSheet({
  open,
  debt,
  onClose,
}: {
  open: boolean;
  debt: Debt | null;
  onClose: () => void;
}) {
  const { db } = useDb();
  const [label, setLabel] = useState("");
  const [balance, setBalance] = useState("");
  const [apr, setApr] = useState("");
  const [minimum, setMinimum] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(debt?.label ?? "");
    setBalance(debt ? (debt.balance_cents / 100).toFixed(2) : "");
    setApr(debt ? (debt.apr_bps / 100).toFixed(2) : "");
    setMinimum(debt ? (debt.min_payment_cents / 100).toFixed(2) : "");
    setError(null);
    setConfirmRemove(false);
  }, [open, debt]);

  async function save() {
    setError(null);
    if (!label.trim()) {
      setError("Give it a name, like Card A.");
      return;
    }
    let balanceCents: number;
    let aprBps: number;
    let minCents: number;
    try {
      balanceCents = await parseAmount(balance);
      aprBps = await parseAmount(apr); // "27.99" % -> 2799 basis points
      minCents = minimum.trim() ? await parseAmount(minimum) : 0;
    } catch {
      setError("Enter a balance like 2,400, an APR like 27.99, and a minimum like 72.");
      return;
    }
    if (balanceCents < 0 || aprBps < 0 || minCents < 0) {
      setError("Amounts can't be negative.");
      return;
    }
    const stamp = new Date().toISOString();
    if (debt) {
      await db.debts.update(debt.id, {
        label: label.trim(),
        balance_cents: balanceCents,
        apr_bps: aprBps,
        min_payment_cents: minCents,
        updated_at: stamp,
      });
    } else {
      await db.debts.add({
        id: newId(),
        label: label.trim(),
        balance_cents: balanceCents,
        apr_bps: aprBps,
        min_payment_cents: minCents,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={debt ? "Edit debt" : "Add a card or loan"}>
      <label className="auth__field">
        <span className="auth__label">Name</span>
        <input
          className="auth__input"
          placeholder="e.g. Card A"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">Balance</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="2,400"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">APR %</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="27.99"
          value={apr}
          onChange={(e) => setApr(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">Minimum payment</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="72"
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
        />
      </label>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={save}>
        {debt ? "Save" : "Add"}
      </Button>
      {debt ? (
        <Button
          block
          variant="ghost"
          onClick={async () => {
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            await db.debts.delete(debt.id);
            await recordDeletion(db, "debts", [debt.id]);
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
