import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useEntitlements } from "../features/billing/entitlements.ts";

/** While a plan has ended: the plan (to subscribe), Me, Money & data (export) and deletion. */
const LAPSED_OPEN = new Set(["/me/plan", "/me", "/me/data", "/me/delete"]);

/**
 * While choosing: /start, and the plan screen — an inbox that already had its free trial is
 * answered 409 trial_used, and buying a plan is then its only way forward (invariant 15).
 */
const CHOOSE_OPEN = new Set(["/start", "/me/plan"]);

/**
 * Trials (owner decision, October 14, 2026). A new account picks its free trial first; an
 * account whose trial or paid plan ended with no subscription can only subscribe, export or
 * delete until the account is deleted. Acts only on what the server said (never on the
 * offline fallback), so a device without signal is never locked out by mistake.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { entitlements, known } = useEntitlements();
  const { pathname } = useLocation();
  const state = known ? entitlements.access?.state : undefined;
  if (state === "choose" && !CHOOSE_OPEN.has(pathname)) return <Navigate to="/start" replace />;
  if (state !== "choose" && pathname === "/start") return <Navigate to="/" replace />;
  // A disputed payment pauses the plan the same way (October 24, 2026), and a lost dispute ends
  // it (October 25, 2026); neither is ever deleted for it.
  if ((state === "lapsed" || state === "paused" || state === "ended") && !LAPSED_OPEN.has(pathname))
    return <Navigate to="/me/plan" replace />;
  return <>{children}</>;
}
