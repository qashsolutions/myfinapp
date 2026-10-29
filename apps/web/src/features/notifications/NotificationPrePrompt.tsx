import "../pwa/pwa.css";

import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { APP_NAME } from "../../lib/brand.ts";
import {
  type PushOutcome,
  pushOutcomeText,
  RETRYABLE_OUTCOMES,
  subscribeToPush,
} from "../../pwa/pushSubscribe.ts";

/**
 * "Stay on track" (mockup PwaNotify): the explainer before the browser's permission dialog.
 * Turning on always ends (invariant 63): on success the sheet closes; on any failure it stays
 * open and says what happened and what to try, with Try again only where another tap can help.
 */
export function NotificationPrePrompt({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (outcome: PushOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<PushOutcome | null>(null);
  async function turnOn() {
    setBusy(true);
    setFailed(null);
    let outcome: PushOutcome;
    try {
      outcome = await subscribeToPush();
    } catch {
      outcome = "push_failed";
    }
    setBusy(false);
    if (outcome !== "subscribed") setFailed(outcome);
    onDone(outcome);
  }
  function close() {
    setFailed(null);
    onClose();
  }
  const canRetry = failed === null || RETRYABLE_OUTCOMES.includes(failed);
  return (
    <Sheet open={open} onClose={close} title="Stay on track">
      <p className="auth__hint">A few useful nudges. No spam, no marketing.</p>
      <ul className="install-benefits">
        <li>
          <strong>Challenge check-ins.</strong> One reminder a day, at a time you pick
        </li>
        <li>
          <strong>Bills due soon.</strong> 3 days before a bill you've added
        </li>
        <li>
          <strong>Weekly recap.</strong> Sunday mornings: what you kept
        </li>
      </ul>
      {failed ? (
        <p className="auth__error" role="alert">
          {pushOutcomeText(failed)}
        </p>
      ) : null}
      {canRetry ? (
        <Button block onClick={turnOn} disabled={busy}>
          {busy ? "Turning on…" : failed ? "Try again" : "Turn on notifications"}
        </Button>
      ) : null}
      <Button block variant="ghost" onClick={close}>
        {failed && !canRetry ? "Close" : "Not now"}
      </Button>
      <p className="auth__hint">
        Change anytime in Settings. On iPhone, {APP_NAME} must be on your Home Screen first. Alerts
        never include amounts or merchant names.
      </p>
    </Sheet>
  );
}
