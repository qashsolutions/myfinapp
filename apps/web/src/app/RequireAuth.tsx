import { Navigate, Outlet, useLocation } from "react-router";
import { DbProvider } from "../data/DbProvider.tsx";
import { useSession } from "../features/auth/useSession.tsx";
import { StepUpProvider } from "../features/security/StepUpPrompt.tsx";
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
  if (status === "signed_out")
    return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
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
