/**
 * 5-minute inactivity lock (docs/spec.md "Account security (day 1)"). Any pointer, key or
 * scroll counts as activity; coming back to a backgrounded tab re-checks the clock so a
 * phone left in a pocket locks too. Locking tells the server to lock this session too
 * (POST /api/auth/lock), and the server's idle clock counts only what the person does (calls
 * the app makes on its own carry X-Qash-Background). Unlocking is a passkey assertion.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { useSession } from "../features/auth/useSession.tsx";
import { LockScreen } from "../features/security/LockScreen.tsx";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
const CHECK_EVERY_MS = 15_000;

export function SessionLock({ children }: { children: ReactNode }) {
  const session = useSession();
  const lastActivity = useRef(Date.now());
  const lockAfterMs = (session.info?.lock_after_seconds ?? 300) * 1000;
  const ready = session.status === "ready";

  useEffect(() => {
    if (!ready) return;
    lastActivity.current = Date.now();
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const check = () => {
      if (Date.now() - lastActivity.current > lockAfterMs) session.lock();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, mark, { passive: true });
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, mark);
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [ready, lockAfterMs, session.lock]);

  if (session.status === "locked") return <LockScreen />;
  return <>{children}</>;
}
