import { useEffect, useRef } from "react";
import { syncBackup } from "../../data/backup/sync.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import { engine } from "../../engine/bridge.ts";
import { isOnline, onNetworkChange } from "../../pwa/network.ts";
import { useSession } from "../auth/useSession.tsx";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Keeps this device in step with the backup while the app is open: a sync on open, whenever
 * the connection comes back, when the tab becomes visible, and every five minutes. Does nothing
 * until backup is on for this device (a key in `settings`).
 */
export function useBackupSync(): void {
  const { db } = useDb();
  const { info } = useSession();
  const userId = info?.user?.id ?? null;
  const running = useRef(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const run = () => {
      if (!alive || running.current || !isOnline()) return;
      running.current = true;
      void (async () => {
        if (!(await db.settings.get("backup.key"))) return;
        await syncBackup(db, userId, engine.rulesVersion ?? "unknown");
      })()
        .catch(ignoreClosed)
        .catch(() => null)
        .finally(() => {
          running.current = false;
        });
    };
    run();
    const timer = setInterval(run, SYNC_INTERVAL_MS);
    const offNetwork = onNetworkChange(run);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      offNetwork();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [db, userId]);
}

export function BackupSync() {
  useBackupSync();
  return null;
}
