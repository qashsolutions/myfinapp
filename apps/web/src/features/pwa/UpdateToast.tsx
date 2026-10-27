import "./pwa.css";

import { Button } from "@stackd/ui";
import { useEffect, useSyncExternalStore } from "react";
import { getUpdateStore } from "../../pwa/updates.ts";

const noop = () => () => {};

/** "A new version is ready. Refresh" (mockup PwaUpdate): never swaps the app under the user. */
export function UpdateToast() {
  const store = getUpdateStore();
  const state = useSyncExternalStore(
    store?.subscribe ?? noop,
    () => store?.get().needRefresh ?? false,
  );
  if (!store || !state) return null;
  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span>A new version is ready.</span>
      <span style={{ display: "flex", gap: 8 }}>
        <Button size="sm" variant="ghost" onClick={store.dismiss}>
          <span style={{ color: "inherit" }}>Later</span>
        </Button>
        <Button size="sm" onClick={() => void store.apply()}>
          Refresh
        </Button>
      </span>
    </div>
  );
}

/**
 * Signed-out start pages (October 13, 2026): there is nothing on them to lose, so a waiting
 * update is applied at once. Without this, someone who opened Welcome before a release kept the
 * old screens, because the toast above lives inside the signed-in app.
 */
export function useApplyUpdateNow() {
  const store = getUpdateStore();
  const waiting = useSyncExternalStore(
    store?.subscribe ?? noop,
    () => store?.get().needRefresh ?? false,
  );
  useEffect(() => {
    if (store && waiting) void store.apply();
  }, [store, waiting]);
}
