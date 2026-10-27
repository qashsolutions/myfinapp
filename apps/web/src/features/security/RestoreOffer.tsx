import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { localKey } from "../../data/backup/sync.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { useEntitlements } from "../billing/entitlements.ts";

const DISMISSED = "backup.restore_offer_dismissed";

/**
 * A new device for someone with encrypted backup (October 13, 2026): Home offers to bring their
 * data here straight after sign-in, instead of leaving it under Me → Security & backup. Shown
 * only on plans with backup, only when the account has a backup and this device has no key yet,
 * and until the person restores or says not now. Restoring itself happens in BackupSettings.
 */
export function RestoreOffer() {
  const { db } = useDb();
  const navigate = useNavigate();
  const { entitlements } = useEntitlements();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!entitlements.backup) return;
    let alive = true;
    void (async () => {
      if ((await db.settings.get(DISMISSED))?.value) return;
      if ((await localKey(db)) !== null) return;
      const r = await api.GET("/api/backup");
      if (!alive || failureOf(r) || !r.data) return;
      const status = r.data as { enabled: boolean; latest: unknown };
      setShow(status.enabled && status.latest !== null);
    })();
    return () => {
      alive = false;
    };
  }, [db, entitlements.backup]);

  if (!show) return null;

  async function notNow() {
    setShow(false);
    await db.settings.put({ key: DISMISSED, value: true, updated_at: new Date().toISOString() });
  }

  return (
    <Card as="div" aria-labelledby="restore-offer" className="restore-offer">
      <div className="restore-offer__row">
        <span className="restore-offer__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 8.5a4 4 0 01-.5 9.5M12 11v8m0 0l-3-3m3 3l3-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span>
          <p className="restore-offer__title" id="restore-offer">
            Your backup is ready for this device
          </p>
          <p className="restore-offer__sub">
            Bring your entries, budgets and jars here in one step.
          </p>
        </span>
      </div>
      <div className="restore-offer__actions">
        <Button onClick={() => navigate("/me/security")}>Restore</Button>
        <Button variant="secondary" onClick={notNow}>
          Not now
        </Button>
      </div>
    </Card>
  );
}
