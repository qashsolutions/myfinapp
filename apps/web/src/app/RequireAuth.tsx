import { Navigate, Outlet, useLocation } from "react-router";
import { DbProvider } from "../data/DbProvider.tsx";
import { useSession } from "../features/auth/useSession.tsx";
import { StepUpProvider } from "../features/security/StepUpPrompt.tsx";
import { keptAccount } from "../lib/keptAccount.ts";
import { rememberReturn } from "../lib/returnTo.ts";
import { AccessGate } from "./AccessGate.tsx";
import { SessionLock } from "./SessionLock.tsx";

/** Gate for the app proper: signed in with a passkey, and unlocked (or the lock screen). */
export function RequireAuth() {
  const { status } = useSession();
  const location = useLocation();
  if (status === "loading") {
    return (
      <p className="sr-only" role="status">
        Loading
      </p>
    );
  }
  // Signed out or mid-sign-up: remember where this was going (a challenge or household link,
  // query and fragment too), so the way in ends there (invariant 37).
  if (status === "signed_out" || status === "needs_passkey")
    rememberReturn(`${location.pathname}${location.search}${location.hash}`);
  // An account that closed when its plan ended, its data still here: every signed-out open
  // leads to that data (download, erase, start again), not to a sign-in that can't work
  // (invariant 57).
  if (status === "signed_out" && keptAccount()) return <Navigate to="/kept" replace />;
  if (status === "signed_out") return <Navigate to="/welcome" replace />;
  if (status === "needs_passkey") return <Navigate to="/signup/passkey" replace />;
  return (
    <StepUpProvider>
      <SessionLock>
        <DbProvider>
          <AccessGate>
            <Outlet />
          </AccessGate>
        </DbProvider>
      </SessionLock>
    </StepUpProvider>
  );
}

/** The sign-in screens: bounce a ready session back into the app. */
export function PublicOnly() {
  const { status } = useSession();
  if (status === "ready" || status === "locked") return <Navigate to="/" replace />;
  if (status === "needs_passkey") return <Navigate to="/signup/passkey" replace />;
  return <Outlet />;
}
