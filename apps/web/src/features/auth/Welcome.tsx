import { Button, buttonClass } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { APP_NAME, PRIVACY_URL, TERMS_URL } from "../../lib/brand.ts";
import { forgetAccount, lastAccount } from "../../lib/lastAccount.ts";
import { biometricName, isNativePlatform, isStandalone } from "../../lib/platform.ts";
import { installPlatform } from "../../pwa/install.ts";
import { InstallGuide } from "../pwa/InstallGuide.tsx";
import { useApplyUpdateNow } from "../pwa/UpdateToast.tsx";
import { PasskeyError, passkeysSupported, signInWithPasskey } from "../security/webauthn.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { PhoneLinkEntry } from "./LinkWithPhone.tsx";
import { NoBiometricsHelp } from "./NoBiometricsHelp.tsx";
import { useSession } from "./useSession.tsx";

const POINTS: Array<[string, string, string]> = [
  // Owner wording (October 13, 2026): the headline is the Private plan's promise, so the line
  // under it names the plans: Private reads statements on the phone; Connected links banks.
  [
    "phone",
    "Your data stays on your device",
    "On Private, statements and receipts are read on your phone. Connected links your bank and cards, read-only.",
  ],
  ["lock", "We never see your bank password", `Sign in with an email code and ${biometricName()}`],
  ["shield", "No ads. No AI services.", "Everything runs on your device"],
];

function Icon({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    phone: "M8 3h8a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2zm3 15h2",
    lock: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4",
    install: "M12 4v11m0 0l-4-4m4 4l4-4M5 19h14",
    fingerprint:
      "M12 11v3m-3.5-4a3.5 3.5 0 017 0v2.5M6 9a6 6 0 0112 0v3M9 14.5c0 2 .6 3.5 1.6 5M15.5 13.5c0 2.5-.5 4.5-1.5 6M5.5 14c.3 1.8.9 3.2 1.8 4.3",
  };
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={paths[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Welcome & sign-in (docs/spec.md "Navigation & screens"; mockup F1Welcome).
 *
 * October 13, 2026: nobody who can be recognised is asked to sign up again. Someone who signed
 * in on this device before sees "Welcome back" and continues with one Face ID / Touch ID tap;
 * anyone whose passkey synced here (iCloud Keychain, Google Password Manager) can do the same
 * from "Sign in with a passkey"; the email code stays for everyone else. In a phone's browser
 * tab, installing comes first (on iPhone the installed app keeps its own storage). */
export function Welcome() {
  const navigate = useNavigate();
  const session = useSession();
  const [returning, setReturning] = useState(lastAccount);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);
  const canPasskey = passkeysSupported();
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const phoneTab = /iPhone|iPod|Android/.test(ua) && !isStandalone() && !isNativePlatform();
  const iphone = installPlatform() === "iphone";
  useEffect(() => {
    document.title = APP_NAME;
  }, []);
  useApplyUpdateNow(); // nothing typed here yet, so a waiting update applies straight away

  async function passkey() {
    setNote(null);
    setBusy(true);
    try {
      await signInWithPasskey(isStandalone() ? "standalone" : "browser");
      await session.refresh();
      navigate("/", { replace: true });
    } catch (err) {
      // Browsers report "no passkey on this device" and "closed the prompt" the same way (by
      // design, so a site can't probe what is stored), so both get the same friendly way on.
      if (err instanceof PasskeyError && err.code === "cancelled")
        setNote(`No ${APP_NAME} passkey on this device yet? Continue with your email.`);
      else if (err instanceof PasskeyError && err.code === "no_passkeys")
        setNote(`No ${APP_NAME} passkey on this device yet. Continue with your email instead.`);
      else setNote("That didn't work. Try again, or continue with your email.");
    } finally {
      setBusy(false);
    }
  }

  function differentAccount() {
    forgetAccount();
    setReturning(null);
    navigate("/signin");
  }

  const install = phoneTab ? (
    <div className="auth__install sk-card">
      <span className="auth__point-icon">
        <Icon kind="install" />
      </span>
      <span className="auth__install-text">
        <strong>Install {APP_NAME} first</strong>
        {iphone
          ? "On iPhone, the Home Screen app keeps its own data. Add it first, then sign in there."
          : "Full screen, works offline, one tap from your home screen."}
      </span>
      <Button variant="secondary" onClick={() => setGuide(true)}>
        How
      </Button>
    </div>
  ) : null;

  return (
    <AuthLayout brand footer>
      {returning ? (
        <>
          <h1 className="auth__hero">Welcome back{returning.name ? `, ${returning.name}` : ""}.</h1>
          <p className="auth__lead">Your money, right where you left it.</p>
          <div className="auth__back-card sk-card">
            <span className="auth__avatar" aria-hidden="true">
              {returning.initial}
            </span>
            <span className="auth__who">{returning.masked}</span>
            {canPasskey ? (
              <Button block onClick={passkey} disabled={busy}>
                <span className="auth__fingerprint">
                  <Icon kind="fingerprint" />
                  Continue with {biometricName()}
                </span>
              </Button>
            ) : (
              <Link to="/signin" className={buttonClass({ block: true })}>
                Continue
              </Link>
            )}
            {canPasskey ? <NoBiometricsHelp onUsePhone={passkey} /> : null}
            <PhoneLinkEntry />
            <button type="button" className="auth__link" onClick={differentAccount}>
              Use a different account
            </button>
          </div>
          {note ? (
            <p className="auth__note" role="alert">
              {note} <Link to="/signin">Use email</Link>
            </p>
          ) : null}
          {install}
          <div className="auth__spacer" />
        </>
      ) : (
        <>
          <h1 className="auth__hero">Keep more of what you earn.</h1>
          <p className="auth__lead">
            See money in and out, spot a shortfall before it happens, and save toward what matters.
          </p>
          {install}
          <ul className="auth__points sk-card">
            {POINTS.map(([icon, title, sub]) => (
              <li className="auth__point" key={title}>
                <span className="auth__point-icon">
                  <Icon kind={icon} />
                </span>
                <span className="auth__point-text">
                  <span className="auth__point-title">{title}</span>
                  <span className="auth__point-sub">{sub}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="auth__spacer" />
          {note ? (
            <p className="auth__note" role="alert">
              {note} <Link to="/signin">Use email</Link>
            </p>
          ) : null}
          <div className="auth__actions">
            <Link to="/signin" className={buttonClass({ block: true })}>
              Get started
            </Link>
            {canPasskey ? (
              <Button variant="secondary" block onClick={passkey} disabled={busy}>
                <span className="auth__fingerprint">
                  <Icon kind="fingerprint" />
                  Sign in with {biometricName()}
                </span>
              </Button>
            ) : (
              <Link to="/signin" className={buttonClass({ variant: "secondary", block: true })}>
                I already have an account
              </Link>
            )}
            {canPasskey ? <NoBiometricsHelp onUsePhone={passkey} /> : null}
            <PhoneLinkEntry />
          </div>
        </>
      )}
      <p className="auth__fineprint">
        By continuing you agree to the <a href={TERMS_URL}>Terms</a> and{" "}
        <a href={PRIVACY_URL}>Privacy Policy</a>.
      </p>
      <InstallGuide open={guide} onClose={() => setGuide(false)} />
    </AuthLayout>
  );
}
