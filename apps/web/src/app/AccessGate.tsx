import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { type Access, useEntitlements } from "../features/billing/entitlements.ts";

/**
 * Open while there is no plan to use: the plan (to subscribe, and receipts), Me, Money & data
 * (export) and deletion. Every other screen sends the person to `home` for their state.
 */
export const LAPSED_OPEN = new Set(["/me/plan", "/me", "/me/data", "/me/delete"]);

/**
 * Where each access state may go, and where it is sent otherwise (null = anywhere).
 * One table so every state is checked the same way (`tests/unit/trials.test.tsx`).
 */
export function accessRoutes(access: Access | null | undefined): {
  home: string;
  open: ReadonlySet<string>;
} | null {
  switch (access?.state) {
    // A new account picks its trial first; Me (to log out) and deleting stay open, since an
    // account must always be deletable in the app (spec hard constraint 5). Signing up again
    // with an inbox that already had its trial (October 28, 2026): /start says so and leads to
    // the plans, so the plan screen opens too, as when a plan ends.
    case "choose":
      return access.trial_used
        ? { home: "/start", open: new Set([...LAPSED_OPEN, "/start"]) }
        : { home: "/start", open: new Set(["/start", "/me", "/me/data", "/me/delete"]) };
    // A plan that ended, a disputed payment (October 24, 2026) and a lost dispute (October 25,
    // 2026): subscribe (where allowed), export or delete; never deleted for a dispute.
    case "lapsed":
    case "paused":
    case "ended":
      return { home: "/me/plan", open: LAPSED_OPEN };
    default:
      return null;
  }
}

/**
 * Trials (owner decision, October 14, 2026). A new account picks its free trial first; an
 * account whose trial or paid plan ended with no subscription can only subscribe, export or
 * delete until the account is deleted. Acts only on what the server said (never on the
 * offline fallback), so a device without signal is never locked out by mistake.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const { entitlements, known } = useEntitlements();
  const { pathname } = useLocation();
  const access = known ? entitlements.access : null;
  const routes = accessRoutes(access);
  if (routes && !routes.open.has(pathname)) return <Navigate to={routes.home} replace />;
  // /start is only for picking a trial or being told it was used.
  if (known && access?.state !== "choose" && pathname === "/start")
    return <Navigate to="/" replace />;
  return <>{children}</>;
}
