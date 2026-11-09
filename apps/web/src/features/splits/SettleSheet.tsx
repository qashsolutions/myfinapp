import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { ChipChoice } from "./ChipChoice.tsx";
import type { PayApp } from "./ledger.ts";
import {
  namesOf,
  PAY_APPS,
  recordPayment,
  type SplitGroupOut,
  splitErrorText,
} from "./useSplits.ts";

export interface Payment {
  from: string;
  to: string;
  cents: number;
}

/**
 * Mark paid (spec "Settling up"): any amount, so part payments work. Recorded by the person
 * paid or the organizer it counts; recorded by the payer it waits for the person paid to confirm.
 * Qash never moves the money.
 */
export function SettleSheet({
  group,
  payment,
  onClose,
  onSaved,
}: {
  group: SplitGroupOut;
  payment: Payment | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { db } = useDb();
  const nameOf = namesOf(group);
  const [amountText, setAmountText] = useState("");
  const [via, setVia] = useState<PayApp>("venmo");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAmountText(payment ? (payment.cents / 100).toFixed(2) : "");
    setError(null);
  }, [payment]);
  if (!payment) return null;
  const counts = payment.to === group.my_member_id || group.is_organizer;
  const from = nameOf(payment.from);
  const to = nameOf(payment.to);

  async function save() {
    if (!payment) return;
    let cents: number;
    try {
      cents = await parseAmount(amountText);
    } catch {
      setError(splitErrorText("invalid_amount"));
      return;
    }
    if (cents <= 0) return setError(splitErrorText("invalid_amount"));
    setBusy(true);
    const r = await recordPayment(db, group, { ...payment, cents, via });
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    await onSaved();
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title="Mark paid">
      <p>
        {from === "You" ? "You pay" : `${from} pays`} {to === "You" ? "you" : to}{" "}
        {formatCents(payment.cents)}.
      </p>
      <label className="auth__field">
        <span className="auth__label">How much was paid?</span>
        <input
          className="auth__input"
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
      </label>
      <ChipChoice legend="Paid with" options={PAY_APPS} value={via} onChange={(v) => setVia(v)} />
      <p className="auth__hint">
        {counts
          ? "This settles it for everyone in the group."
          : `${to} confirms it, then it settles for everyone.`}{" "}
        Qash never moves money.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={save} disabled={busy}>
        Mark paid
      </Button>
    </Sheet>
  );
}
