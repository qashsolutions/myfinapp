import { Button } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Logo } from "../../app/layout/Logo.tsx";
import { APP_NAME } from "../../lib/brand.ts";
import { biometricName } from "../../lib/platform.ts";
import { NoBiometricsHelp } from "../auth/NoBiometricsHelp.tsx";
import { useSession } from "../auth/useSession.tsx";
import { assertPasskey, PasskeyError } from "./webauthn.ts";

/**
 * Lock screen (mockup F1Lock): after 5 idle minutes, or on a device that has not passed a
 * passkey check yet (a new device). The platform offers the device passcode itself when
 * biometrics fail, so there is one Unlock button.
 */
export function LockScreen() {
  const session = useSession();
  const navigate = useNavigate();
  const bio = biometricName();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newDevice = !session.info?.passkey_verified_at;

  useEffect(() => {
    document.title = `${APP_NAME} is locked`;
  }, []);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const at = await assertPasskey("unlock");
      session.unlocked(at);
    } catch (err) {
      const e = err instanceof PasskeyError ? err : null;
      setError(
        e?.code === "cancelled"
          ? `${bio} didn't match or was cancelled. Try again, or use your device passcode.`
          : e?.code === "no_passkeys"
            ? "This account has no passkey yet."
            : `${bio} didn't match. Try again, or use your device passcode.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await session.signOut();
    navigate("/welcome", { replace: true });
  }

  return (
    <div className="auth">
      <div className="auth__spacer" />
      <div className="auth__centre">
        <Logo size={84} />
        <h1 className="auth__title">{newDevice ? "Confirm it's you" : `${APP_NAME} is locked`}</h1>
        <p className="auth__lead">
          {newDevice
            ? "Use the passkey you created when you signed up."
            : `Locked after ${Math.round((session.info?.lock_after_seconds ?? 300) / 60)} minutes without activity. Unlock to pick up where you left off.`}
        </p>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="auth__spacer" />
      <div className="auth__actions">
        <Button block onClick={unlock} disabled={busy}>
          {busy ? "Waiting for your device…" : `Unlock with ${bio}`}
        </Button>
        <NoBiometricsHelp onUsePhone={unlock} />
        {newDevice ? (
          // A passkey can only be added once unlocked (the server asks for a passkey check
          // first), so a new device unlocks with the one it has elsewhere; once in, Me → Sign-in
          // & security adds one here.
          <p className="auth__hint">
            No passkey on this device? Tap Unlock and pick the device that has it, such as your
            phone. Once you're in, you can add a passkey here in Sign-in &amp; security.
          </p>
        ) : null}
        <Button block variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
