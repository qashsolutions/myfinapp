import { Button, buttonClass, Sheet } from "@stackd/ui";
import { useState } from "react";
import { api, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { newId } from "../../data/db.ts";
import { dayOf, formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { ChipChoice } from "./ChipChoice.tsx";
import type { HandleApp, ProfileBlob } from "./ledger.ts";
import {
  APP_NAME,
  CHANGED_RECENTLY_DAYS,
  PAY_WARNING_VERSION,
  payLink,
  showHandle,
} from "./payLinks.ts";
import type { Payment } from "./SettleSheet.tsx";
import { SpendingChoiceFields, useSpendingChoice } from "./SpendingChoice.tsx";
import { notifyMember, recordPayment, type SplitGroupOut, splitErrorText } from "./useSplits.ts";

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Check first (spec "Before you pay", Zelle-style, owner decision November 8, 2026): before any
 * pay button opens an app, who, how much, the handle and when its owner saved it, and two boxes
 * to tick. The confirmation is kept on this device (Me → Payments I confirmed); the server gets
 * the warning's version only. Then the person's app opens with the amount, and "I've paid"
 * records it for the person paid to confirm.
 */
export function CheckFirstSheet({
  group,
  payment,
  toName,
  profile,
  reported,
  onClose,
  onReport,
  onPaid,
}: {
  group: SplitGroupOut;
  payment: Payment | null;
  toName: string;
  profile: (ProfileBlob & { updated_at: string }) | null;
  reported: boolean;
  onClose: () => void;
  onReport: () => void;
  onPaid: () => Promise<void>;
}) {
  const { db } = useDb();
  const apps = (Object.keys(APP_NAME) as HandleApp[]).filter((a) => profile?.handles[a]);
  const [app, setApp] = useState<HandleApp | null>(apps[0] ?? null);
  const [knows, setKnows] = useState(false);
  const [owes, setOwes] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A payment I send is my spending once, if I choose (S.6, invariant 76).
  const spending = useSpendingChoice(group.id, payment?.from === group.my_member_id);
  if (!payment || !profile || !app) return null;
  const handle = profile.handles[app] as string;
  const changedAt = profile.changed[app] ?? profile.saved_at;
  const recent = changedAt !== "" && daysSince(changedAt) < CHANGED_RECENTLY_DAYS;

  async function confirm() {
    if (!payment || !app) return;
    setBusy(true);
    const r = await api.POST("/api/splits/pay-consent", { body: { version: PAY_WARNING_VERSION } });
    const failure = failureOf(r);
    if (failure) {
      setBusy(false);
      return setError(splitErrorText(failure.code));
    }
    const at = new Date().toISOString();
    await db.split_payments.put({
      id: newId(),
      group_id: group.id,
      to_name: toName,
      to_member: payment.to,
      cents: payment.cents,
      app,
      handle,
      knows_them: true,
      owes_this: true,
      warning_version: PAY_WARNING_VERSION,
      at,
      updated_at: at,
    });
    setBusy(false);
    setChecked(true);
  }

  async function paid() {
    if (!payment || !app) return;
    setBusy(true);
    const r = await recordPayment(db, group, { ...payment, via: app });
    if (r.ok) await spending.apply({ settlementId: r.id, cents: payment.cents, to: toName });
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    // S.10: unless I run the group (then it counts at once), they're asked to confirm.
    if (!group.is_organizer) void notifyMember(group.id, "paid", payment.to);
    await onPaid();
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title="Check first">
      {!checked ? (
        <>
          <p>
            <strong>Money you send can't be pulled back.</strong>
          </p>
          {reported ? (
            <p className="auth__error" role="alert">
              Reported. Don't pay unless you're sure.
            </p>
          ) : null}
          <p>
            Pay {toName} {formatCents(payment.cents)}
          </p>
          {apps.length > 1 ? (
            <ChipChoice
              legend="With"
              options={apps.map((a) => [a, APP_NAME[a]] as const)}
              value={app}
              onChange={(v) => setApp(v)}
            />
          ) : null}
          <p>
            {APP_NAME[app]} {showHandle(app, handle)}
            {changedAt ? ` · saved ${formatDay(dayOf(changedAt))}` : ""}
          </p>
          {recent ? (
            <p className="auth__error" role="alert">
              Changed recently · check with {toName} before you pay.
            </p>
          ) : null}
          <label className="split-person">
            <input type="checkbox" checked={knows} onChange={(e) => setKnows(e.target.checked)} /> I
            know {toName} in real life.
          </label>
          <label className="split-person">
            <input type="checkbox" checked={owes} onChange={(e) => setOwes(e.target.checked)} /> I
            checked the bills and I owe this amount.
          </label>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          <Button block onClick={confirm} disabled={!knows || !owes || busy}>
            Continue
          </Button>
          <Button block variant="ghost" onClick={onReport}>
            Something's wrong · Report
          </Button>
        </>
      ) : (
        <>
          <p role="status">Kept in Me → Payments I confirmed ({formatDay(todayIso())}).</p>
          <a
            className={buttonClass({ block: true })}
            href={payLink(app, handle, payment.cents)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open {APP_NAME[app]} · {formatCents(payment.cents)}
          </a>
          <p className="auth__hint">
            Qash never moves money. After you pay, tell {toName} it's done; they confirm it.
          </p>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          <SpendingChoiceFields choice={spending} />
          <Button block variant="secondary" onClick={paid} disabled={busy}>
            I've paid · Mark paid
          </Button>
        </>
      )}
    </Sheet>
  );
}
