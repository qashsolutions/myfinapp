/**
 * Step-up check (mockup F1StepUp): a fresh passkey check before export, deletion, email
 * change, plan change, bank linking, and removing passkeys or devices, even while unlocked.
 *
 *   const stepUp = useStepUp();
 *   const ok = await stepUp.confirm("Downloading all your data");
 */

import { Button, Sheet } from "@stackd/ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { biometricName } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { assertPasskey, PasskeyError } from "./webauthn.ts";

export interface StepUp {
  /** Shows the sheet unless the last passkey check is still fresh. Resolves false on cancel. */
  confirm: (what: string) => Promise<boolean>;
}

const StepUpContext = createContext<StepUp | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [what, setWhat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const bio = biometricName();

  const finish = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setWhat(null);
    setError(null);
  }, []);

  const confirm = useCallback(
    (label: string) => {
      const at = session.info?.passkey_verified_at;
      const maxAge = (session.info?.step_up_max_age_seconds ?? 300) * 1000;
      if (at && Date.now() - new Date(at).getTime() < maxAge) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setWhat(label);
      });
    },
    [session.info],
  );

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const at = await assertPasskey("step_up");
      session.unlocked(at);
      finish(true);
    } catch (err) {
      const e = err instanceof PasskeyError ? err : null;
      setError(
        e?.code === "cancelled"
          ? "Cancelled. Try again when you're ready."
          : `${bio} didn't match. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const value = useMemo<StepUp>(() => ({ confirm }), [confirm]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Sheet open={what !== null} onClose={() => finish(false)} title="Confirm it's you">
        <p className="auth__lead" style={{ textAlign: "center" }}>
          {what} needs a quick check, even while the app is unlocked.
        </p>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={run} disabled={busy}>
          {busy ? "Waiting for your device…" : `Confirm with ${bio}`}
        </Button>
        <Button block variant="secondary" onClick={() => finish(false)}>
          Cancel
        </Button>
        <p className="auth__fineprint">We'll also email you that this happened.</p>
      </Sheet>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUp {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp must be used inside <StepUpProvider>");
  return ctx;
}
