import { useEffect } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { SYNC_EVERY_MS, syncIfDue } from "./sync.ts";

/**
 * Mounted once in AppShell (chunk 3.3): pulls linked accounts on open, when the app comes back
 * to the foreground or the network returns, and every 15 minutes while open. Does nothing, and
 * asks the server nothing, on a device without a linked account.
 */
export function LinkedSync() {
  const { db } = useDb();
  useEffect(() => {
    let running = false;
    const run = () => {
      if (running || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      running = true;
      void syncIfDue(db).finally(() => {
        running = false;
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    run();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", run);
    const timer = window.setInterval(run, SYNC_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", run);
      window.clearInterval(timer);
    };
  }, [db]);
  return null;
}
