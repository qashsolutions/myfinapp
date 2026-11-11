import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { ChipChoice } from "./ChipChoice.tsx";
import { NOTE_MAX, type PayApp } from "./ledger.ts";
import { SpendingChoiceFields, useSpendingChoice } from "./SpendingChoice.tsx";
import {
  namesOf,
  notifyMember,
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
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Paying a friend counts once as my spending (S.6, invariant 76).
  const spending = useSpendingChoice(group.id, payment?.from === group.my_member_id);
  useEffect(() => {
    setAmountText(payment ? (payment.cents / 100).toFixed(2) : "");
    setNote("");
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
    const r = await recordPayment(db, group, { ...payment, cents, via, note });
    if (r.ok) await spending.apply({ settlementId: r.id, cents, to: nameOf(payment.to) });
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    // S.10: the person paid is asked to confirm a payer's claim; a payer hears theirs counts.
    if (!counts && payment.from === group.my_member_id)
      void notifyMember(group.id, "paid", payment.to);
    else if (counts && payment.from !== group.my_member_id)
      void notifyMember(group.id, "confirmed", payment.from);
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
      <label className="auth__field">
        <span className="auth__label">Note (optional)</span>
        <input
          className="auth__input"
          value={note}
          maxLength={NOTE_MAX}
          placeholder="For the cabin weekend"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <SpendingChoiceFields choice={spending} />
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
