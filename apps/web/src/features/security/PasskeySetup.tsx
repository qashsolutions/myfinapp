import { Button } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { APP_NAME } from "../../lib/brand.ts";
import { biometricName } from "../../lib/platform.ts";
import { AuthLayout } from "../auth/AuthLayout.tsx";
import { NoBiometricsHelp } from "../auth/NoBiometricsHelp.tsx";
import { useSession } from "../auth/useSession.tsx";
import { PasskeyError, passkeysSupported, registerPasskey } from "./webauthn.ts";

function FaceIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M4 16v3a1 1 0 001 1h3M16 20h3a1 1 0 001-1v-3M9 9.5v1M15 9.5v1M12 9v4h-1M9 15.5c1.5 1.3 4.5 1.3 6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mandatory passkey at sign-up (mockup F1Passkey). */
export function PasskeySetup() {
  const session = useSession();
  const navigate = useNavigate();
  const bio = biometricName();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `Secure your account · ${APP_NAME}`;
  }, []);

  if (session.status === "signed_out") return <Navigate to="/signin" replace />;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      await session.refresh();
      setDone(true);
    } catch (err) {
      const e =
        err instanceof PasskeyError
          ? err
          : new PasskeyError("failed", "The passkey check didn't complete.");
      setError(
        e.code === "cancelled"
          ? "No passkey was created. Tap Create passkey to try again."
          : e.code === "unsupported"
            ? "This browser can't create passkeys. Try Safari on iPhone, or Chrome or Edge on a computer."
            : e.message,
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthLayout>
        <p className="auth__hint">Last step · Secure your account</p>
        <div className="auth__centre">
          <span className="auth__badge">
            <FaceIcon />
          </span>
          <h1 className="auth__title">You're protected</h1>
          <p className="auth__lead">
            Passkey saved on this device. {APP_NAME} will lock after 5 minutes of inactivity and ask
            for {bio} to reopen. You can change that in Sign-in &amp; security.
          </p>
        </div>
        <div className="auth__spacer" />
        <div className="auth__actions">
          <Button block onClick={() => navigate("/", { replace: true })}>
            Continue to setup
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <p className="auth__hint">Last step · Secure your account</p>
      <div className="auth__centre">
        <span className="auth__badge">
          <FaceIcon />
        </span>
        <h1 className="auth__title">
          Protect {APP_NAME} with {bio}
        </h1>
        <p className="auth__lead">
          We'll create a passkey on this device. You'll unlock with {bio}, or your device passcode
          if {bio} isn't available. It's required to keep your money data safe.
        </p>
      </div>
      <ul className="auth__points sk-card">
        {[
          "No password to remember or leak",
          "Can't be phished by fake sites",
          "Your fingerprint or face never leaves your device",
        ].map((t) => (
          <li className="auth__point" key={t}>
            <span className="auth__dot" aria-hidden="true" />
            <span className="auth__point-title">{t}</span>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="auth__spacer" />
      <div className="auth__actions">
        <Button block onClick={create} disabled={busy || !passkeysSupported()}>
          {busy ? "Waiting for your device…" : "Create passkey"}
        </Button>
        <NoBiometricsHelp onUsePhone={create} />
      </div>
      <p className="auth__fineprint">
        Your device shows its own confirmation next. {APP_NAME} never sees your face or passcode.
      </p>
    </AuthLayout>
  );
}
