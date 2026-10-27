import "../auth/auth.css";
import "../billing/billing.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { closeDb, deleteDb } from "../../data/db.ts";
import { formatCents, formatDate } from "../../lib/format.ts";
import { biometricName } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { type Credit, fetchCredit, isFailure } from "../billing/billing.ts";
import { useStepUp } from "../security/StepUpPrompt.tsx";
import { ExportData } from "./ExportData.tsx";

/** Everything the app keeps in the browser besides the database. */
export function clearLocalPreferences(): void {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("stackd.")) localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to clear
  }
}

/**
 * Delete account (mockup F6Delete), two taps from Me: what goes, the refund, export first, a
 * box to tick (owner, October 17, 2026: clearer than typing a word), a passkey check, then the
 * server soft-deletes and this device wipes its copy.
 */
export function DeleteAccount() {
  const navigate = useNavigate();
  const session = useSession();
  const stepUp = useStepUp();
  useDb(); // the screen only renders with the device database open
  const [agreed, setAgreed] = useState(false);
  const agreeId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = agreed;
  // Shown before anyone deletes (owner decision, October 17, 2026): what comes back to the card.
  const [refund, setRefund] = useState<number | "unknown" | null>(null);
  const [detail, setDetail] = useState<Credit | null>(null);
  useEffect(() => {
    let live = true;
    void fetchCredit().then((r) => {
      if (!live) return;
      setRefund(isFailure(r) ? "unknown" : r.refund_if_deleted_cents);
      if (!isFailure(r)) setDetail(r);
    });
    return () => {
      live = false;
    };
  }, []);

  async function deleteForever() {
    if (!ready) return;
    setError(null);
    if (!(await stepUp.confirm("Deleting your account"))) return;
    setBusy(true);
    try {
      const r = await api.POST("/api/account/delete", { body: { confirm: "DELETE" } });
      const failure = failureOf(r);
      if (failure) {
        setError(
          failure.status === 0
            ? "You're offline. Try again when connected."
            : "Couldn't delete right now. Try again.",
        );
        return;
      }
      const userId = session.info?.user?.id;
      // Leave first: /deleted has no guard, so the sign-out below cannot redirect it, and the
      // wipe below closes the database this screen's tree depends on.
      navigate("/deleted", { replace: true });
      clearLocalPreferences();
      if (userId) {
        closeDb(userId);
        await deleteDb(userId);
      }
      await session.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ScreenHeader title="Delete account" actions={null} back="/me" />
      <p className="auth__label">This permanently deletes:</p>
      <Card as="section" aria-label="What is deleted">
        <ul className="auth__points auth__points--bulleted">
          <li>Your account, passkeys and plan</li>
          <li>Everything on this device: transactions, jars, receipts</li>
          <li>Your encrypted backup</li>
          <li>Group memberships (you'll show as "Former member")</li>
          <li>Linked banks and cards, disconnected at Plaid</li>
        </ul>
      </Card>
      <p className="auth__hint">
        Other devices erase their copy the next time they open, within 30 days. A paid plan ends
        now, with no further charges.
      </p>
      {refund === null || refund === 0 ? null : (
        <Card as="section" aria-label="Your refund">
          <p className="sk-card__eyebrow">Your refund</p>
          {refund === "unknown" ? (
            <p role="status">
              Back to your card: the months of your plan after this one. We couldn't work out the
              amount right now.
            </p>
          ) : (
            <>
              <p className="sk-card__hero" role="status">
                {formatCents(refund)}
              </p>
              <p>
                <strong>
                  Back to the {detail?.refund_fee_method === "bank" ? "bank account" : "card"} you
                  paid with
                </strong>
                , not as credit.
              </p>
              {detail && detail.refund_before_fee_cents > refund ? (
                <p>
                  {formatCents(detail.refund_before_fee_cents)} unused −{" "}
                  {formatCents(detail.refund_before_fee_cents - refund)} Stripe{" "}
                  {detail.refund_fee_method === "bank" ? "bank" : "card"} fee ={" "}
                  {formatCents(refund)}
                </p>
              ) : null}
            </>
          )}
          <p className="auth__hint">
            {detail?.kept_until
              ? `We keep this month (it runs to ${formatDate(detail.kept_until)}). On a yearly plan the months used, this one included, cost the monthly price and the rest of the year comes back, plus any credit on your account.`
              : "It's the credit on your account, at the price you paid."}{" "}
            {detail
              ? detail.refund_fee_method === "bank"
                ? `Stripe keeps its bank fee (${(detail.refund_bank_fee_bps ?? 80) / 100}%, at most ${formatCents(detail.refund_bank_fee_cap_cents ?? 500)}) when a payment is refunded, so it comes off the refund. `
                : `Stripe keeps its card fee (${detail.refund_fee_bps / 100}% + ${detail.refund_fee_fixed_cents}¢) when a payment is refunded, so it comes off the refund. `
              : ""}
            Stripe sends it at once; your bank usually shows it in 5 to 10 days.
          </p>
        </Card>
      )}
      <ExportData label="Download my data first" />
      <label className="consent__agree" htmlFor={agreeId}>
        <input
          id={agreeId}
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span>I understand this permanently deletes my account and its data.</span>
      </label>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block variant="danger" onClick={deleteForever} disabled={!ready || busy}>
        Delete forever
      </Button>
      <p className="auth__fineprint">
        You'll confirm with {biometricName()} next. Deletion finishes within 30 days.
      </p>
    </>
  );
}
