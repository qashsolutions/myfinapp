import "./pwa.css";

import { useEffect, useRef, useState } from "react";
import { isStandalone } from "../../lib/platform.ts";
import { getUpdateStore } from "../../pwa/updates.ts";

/** How far to pull (px, after damping) before letting go refreshes. */
export const PULL_THRESHOLD = 70;

/**
 * Pull down from the top of a screen to refresh (October 18, 2026). Only in the installed app:
 * a browser tab has its own. Refreshing takes a new version when one is ready, otherwise
 * reloads; nothing is lost, because everything lives on the device. Never starts while a sheet
 * is open or someone is typing, and never blocks scrolling.
 */
export function PullToRefresh({ enabled = isStandalone() }: { enabled?: boolean }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const distance = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const typing = () => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      );
    };
    const onStart = (e: TouchEvent) => {
      if (busy || window.scrollY > 0 || typing() || document.querySelector("[role='dialog']")) {
        start.current = null;
        return;
      }
      start.current = e.touches[0]?.clientY ?? null;
      distance.current = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = (e.touches[0]?.clientY ?? start.current) - start.current;
      if (dy <= 0 || window.scrollY > 0) {
        distance.current = 0;
        setPull(0);
        return;
      }
      distance.current = Math.min(110, dy * 0.5);
      setPull(distance.current);
    };
    const onEnd = () => {
      if (start.current === null) return;
      start.current = null;
      const go = distance.current >= PULL_THRESHOLD;
      distance.current = 0;
      setPull(0);
      if (!go) return;
      setBusy(true);
      const store = getUpdateStore();
      void (store ? store.refresh() : Promise.resolve(window.location.reload())).finally(() =>
        setBusy(false),
      );
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, busy]);

  if (!enabled || (pull === 0 && !busy)) return null;
  const ready = pull >= PULL_THRESHOLD;
  return (
    <div
      className="pull-refresh"
      role="status"
      style={{ transform: `translate(-50%, ${busy ? 56 : pull - 20}px)` }}
    >
      <span
        className={`pull-refresh__icon${busy ? " pull-refresh__icon--spin" : ""}`}
        style={busy ? undefined : { transform: `rotate(${ready ? 180 : 0}deg)` }}
        aria-hidden="true"
      >
        ↓
      </span>
      {busy ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh"}
    </div>
  );
}
