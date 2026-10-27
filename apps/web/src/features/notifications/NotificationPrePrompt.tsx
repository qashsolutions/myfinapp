import "../pwa/pwa.css";

import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { APP_NAME } from "../../lib/brand.ts";
import { type PushOutcome, subscribeToPush } from "../../pwa/pushSubscribe.ts";

/** "Stay on track" (mockup PwaNotify): the explainer before the browser's permission dialog. */
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
  async function turnOn() {
    setBusy(true);
    try {
      const outcome = await subscribeToPush();
      onDone(outcome);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Stay on track">
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
      <Button block onClick={turnOn} disabled={busy}>
        Turn on notifications
      </Button>
      <Button block variant="ghost" onClick={onClose}>
        Not now
      </Button>
      <p className="auth__hint">
        Change anytime in Settings. On iPhone, {APP_NAME} must be on your Home Screen first. Alerts
        never include amounts or merchant names.
      </p>
    </Sheet>
  );
}
