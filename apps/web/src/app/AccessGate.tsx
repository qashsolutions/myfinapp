import { type ReactNode, useEffect } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { type Access, useEntitlements } from "../features/billing/entitlements.ts";
import { forgetReturn, pendingReturn, takeReturn } from "../lib/returnTo.ts";

/**
 * Joining a household is a way in (invariant 54): the partner's plan covers both, so an invite
 * opens before picking a trial and while no plan is live, never sending them through /start.
 */
const JOIN_HOUSEHOLD = "/household/join";

/**
 * Open while there is no plan to use: the plan (to subscribe, and receipts), Me, Money & data
 * (export), deletion, and joining a household whose plan would cover them.
 * Every other screen sends the person to `home` for their state.
 */
export const LAPSED_OPEN = new Set(["/me/plan", "/me", "/me/data", "/me/delete", JOIN_HOUSEHOLD]);

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
        : {
            home: "/start",
            open: new Set(["/start", "/me", "/me/data", "/me/delete", JOIN_HOUSEHOLD]),
          };
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
  const navigate = useNavigate();
  // The way in is over (signed in, passkey made, trial picked, the app open to this plan):
  // go where the link that started it pointed (invariant 37).
  const open = known && routes === null;
  useEffect(() => {
    if (!open) return;
    const target = takeReturn();
    if (target) navigate(target, { replace: true });
  }, [open, navigate]);
  // A link this state may already open goes there now, before any trial pick: a household
  // invite, since the partner's plan covers them (invariant 54).
  const pending = routes ? pendingReturn() : null;
  const pendingPath = pending ? new URL(pending, window.location.origin).pathname : null;
  const goBack = pending && pendingPath && routes?.open.has(pendingPath) ? pending : null;
  useEffect(() => {
    if (goBack && pathname === pendingPath) forgetReturn();
  }, [goBack, pathname, pendingPath]);
  if (goBack && pathname !== pendingPath) return <Navigate to={goBack} replace />;
  if (routes && !routes.open.has(pathname)) return <Navigate to={routes.home} replace />;
  // /start is only for picking a trial or being told it was used.
  if (known && access?.state !== "choose" && pathname === "/start")
    return <Navigate to="/" replace />;
  return <>{children}</>;
}
