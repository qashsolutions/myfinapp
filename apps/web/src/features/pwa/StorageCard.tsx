import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { localKey } from "../../data/backup/sync.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  lastExportAt,
  lastOpenBefore,
  type StorageRisk,
  snoozeStorageCard,
  storageCardSnoozedAt,
  storageRisk,
} from "../../data/persist.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { isNativePlatform, isStandalone } from "../../lib/platform.ts";
import { installPlatform } from "../../pwa/install.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { ExportData } from "../settings/ExportData.tsx";
import { InstallGuide } from "./InstallGuide.tsx";

/** An iPhone or iPad browser tab, where Safari's 7-day erase applies. */
export function isIphoneTab(): boolean {
  if (typeof navigator === "undefined") return false;
  return installPlatform() === "iphone" && !isStandalone() && !isNativePlatform();
}

const LINES: Record<NonNullable<StorageRisk>, string> = {
  iphone_tab: `On iPhone, Safari can erase this data after 7 days without a visit. Add ${APP_NAME} to your Home Screen, or turn on backup.`,
  export: "This browser may clear what's stored here. Keep a copy somewhere safe.",
};

/**
 * Home's "keep it safe" card (defect round 3, October 29, 2026; invariant 58): said once a
 * visit, on Home only, until one way out is done; "Not now" quiets it for a few days.
 */
export function StorageCard() {
  const { db, persistence } = useDb();
  const userId = useSession().info?.user?.id ?? null;
  const { entitlements } = useEntitlements();
  const navigate = useNavigate();
  const [risk, setRisk] = useState<StorageRisk>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    let alive = true;
    const lastOpenAt = lastOpenBefore();
    void (async () => {
      const [backupOn, entryCount] = await Promise.all([
        localKey(db).then((k) => k !== null),
        db.entries.count(),
      ]);
      if (!alive) return;
      setRisk(
        storageRisk({
          iphoneTab: isIphoneTab(),
          persistence,
          backupOn,
          entryCount,
          lastExportAt: userId ? lastExportAt(userId) : null,
          snoozedAt: storageCardSnoozedAt(),
          lastOpenAt,
          now: new Date(),
        }),
      );
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [db, persistence, userId]);

  if (!risk) return null;
  return (
    <Card as="section" aria-labelledby="storage-card" className="storage-card">
      <Word>Review</Word>
      <h2 className="storage-card__title" id="storage-card">
        Keep your data safe
      </h2>
      <p className="storage-card__sub">{LINES[risk]}</p>
      <div className="storage-card__actions">
        {risk === "iphone_tab" ? (
          <Button onClick={() => setGuide(true)}>Add to Home Screen</Button>
        ) : null}
        {entitlements.backup ? (
          <Button variant="secondary" onClick={() => navigate("/me/security")}>
            Turn on backup
          </Button>
        ) : null}
        <ExportData label="Download a copy" onSaved={() => setRisk(null)} />
        <Button
          variant="ghost"
          onClick={() => {
            snoozeStorageCard();
            setRisk(null);
          }}
        >
          Not now
        </Button>
      </div>
      <InstallGuide open={guide} onClose={() => setGuide(false)} />
    </Card>
  );
}
