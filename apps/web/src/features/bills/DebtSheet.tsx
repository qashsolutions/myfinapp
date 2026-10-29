import "../auth/auth.css";

import { Button, Sheet } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type Debt, newId } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { APR_SUGGESTIONS, DEBT_KINDS, type DebtKind, debtAprCheck, kindFromLabel } from "./apr.ts";

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
  const ids = useId();
  const [label, setLabel] = useState("");
  // The person's pick; until then the name decides (a "Visa" is a card, a "Car loan" a loan).
  const [pickedKind, setPickedKind] = useState<DebtKind | null>(null);
  const kind: DebtKind = pickedKind ?? kindFromLabel(label);
  // The rate (in bps) the person said is right after the high-rate question, asked once.
  const [confirmedBps, setConfirmedBps] = useState<number | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [balance, setBalance] = useState("");
  const [apr, setApr] = useState("");
  const [minimum, setMinimum] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(debt?.label ?? "");
    setPickedKind(debt?.kind ?? null);
    setConfirmedBps(debt?.kind && debt.kind !== "card" ? debt.apr_bps : null);
    setAsking(null);
    setBalance(debt ? (debt.balance_cents / 100).toFixed(2) : "");
    setApr(debt ? (debt.apr_bps / 100).toFixed(2) : "");
    setMinimum(debt ? (debt.min_payment_cents / 100).toFixed(2) : "");
    setError(null);
    setConfirmRemove(false);
  }, [open, debt]);

  async function save(okBps: number | null = confirmedBps) {
    setError(null);
    setAsking(null);
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
    // A card 0% to 40%; any other debt 0% to 400%, asked once above 40% (owner decision,
    // October 29, 2026).
    const check = debtAprCheck(kind, aprBps);
    if (check && "error" in check) {
      setError(check.error);
      return;
    }
    if (check && "confirm" in check && okBps !== aprBps) {
      setAsking(check.confirm);
      return;
    }
    const stamp = new Date().toISOString();
    if (debt) {
      await db.debts.update(debt.id, {
        label: label.trim(),
        balance_cents: balanceCents,
        apr_bps: aprBps,
        min_payment_cents: minCents,
        kind,
        updated_at: stamp,
      });
    } else {
      await db.debts.add({
        id: newId(),
        label: label.trim(),
        balance_cents: balanceCents,
        apr_bps: aprBps,
        min_payment_cents: minCents,
        kind,
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
      <p className="auth__label">What is it?</p>
      <ChoiceChips
        name={`${ids}-kind`}
        options={DEBT_KINDS}
        value={kind}
        onPick={(v) => {
          setPickedKind(v as DebtKind);
          setAsking(null);
        }}
      />
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
      {kind === "card" ? (
        <>
          <p className="auth__label">Card rate</p>
          <ChoiceChips
            name={`${ids}-apr`}
            options={APR_SUGGESTIONS}
            value={apr}
            onPick={(v) => setApr(v)}
          />
        </>
      ) : null}
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
      {asking ? (
        <fieldset
          aria-label="Check the rate"
          className="own-choice"
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <p className="auth__error" role="alert">
            {asking}
          </p>
          <Button
            block
            onClick={async () => {
              const ok = await parseAmount(apr);
              setConfirmedBps(ok);
              await save(ok);
              setAsking(null);
            }}
          >
            Yes, it's right
          </Button>
          <Button block variant="ghost" onClick={() => setAsking(null)}>
            Fix it
          </Button>
        </fieldset>
      ) : null}
      <Button block onClick={() => void save()}>
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
