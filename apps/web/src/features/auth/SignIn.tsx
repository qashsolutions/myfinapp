import { Button } from "@stackd/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { isStandalone } from "../../lib/platform.ts";
import { armPasskeyAutofill, cancelPasskeyAutofill } from "../security/webauthn.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { PhoneLinkEntry } from "./LinkWithPhone.tsx";
import { useSession } from "./useSession.tsx";

/** A sign-in challenge lives 5 minutes on the server; ask again a little before that. */
const REARM_AFTER_MS = 270_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CodeScreenState {
  email: string;
  resendAfter: number;
  expiresIn: number;
}

/** Email entry (mockup F1Email). The same code signs in and creates the account. */
export function SignIn() {
  const navigate = useNavigate();
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = useSession();
  const armedAt = useRef(0);

  useEffect(() => {
    document.title = `Sign in · ${APP_NAME}`;
  }, []);

  // The browser may offer a saved passkey in the email field's list: one tap, then Face ID or
  // Touch ID, and the person is in. Nothing shows where there's no passkey for Qash.
  function arm() {
    armedAt.current = Date.now();
    void armPasskeyAutofill(isStandalone() ? "standalone" : "browser").then(async (signedIn) => {
      if (!signedIn) return;
      await session.refresh();
      navigate("/", { replace: true });
    });
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: arm once on open, cancel on leaving
  useEffect(() => {
    arm();
    return () => cancelPasskeyAutofill();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) {
      setError("Enter a full email address, like you@example.com");
      return;
    }
    setBusy(true);
    setError(null);
    cancelPasskeyAutofill();
    const result = await api.POST("/api/auth/otp/send", { body: { email: address } });
    setBusy(false);
    const failure = failureOf(result);
    const state: CodeScreenState = {
      email: address,
      resendAfter: result.data?.resend_after_seconds ?? 60,
      expiresIn: result.data?.expires_in_seconds ?? 600,
    };
    if (!failure) {
      navigate("/signin/code", { state });
      return;
    }
    if (failure.code === "too_soon") {
      // The last code is still valid; go and enter it.
      navigate("/signin/code", { state: { ...state, resendAfter: failure.retryAfter ?? 60 } });
      return;
    }
    if (failure.code === "locked") {
      setError("Too many wrong tries. Codes for this address pause for 15 minutes.");
    } else if (failure.code === "rate_limited") {
      setError("Too many requests. Try again in a few minutes.");
    } else {
      setError("We couldn't send the code. Check your connection and try again.");
    }
  }

  return (
    <AuthLayout back="/welcome" footer>
      <h1 className="auth__title">What's your email?</h1>
      <p className="auth__lead">
        We'll send a 6-digit code. There's no password to create or forget.
      </p>
      <form onSubmit={submit} className="auth__field" noValidate>
        <label className="auth__label" htmlFor={id}>
          Email address
        </label>
        <input
          id={id}
          className="auth__input"
          type="email"
          inputMode="email"
          autoComplete="email webauthn"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onFocus={() => {
            if (Date.now() - armedAt.current > REARM_AFTER_MS) arm();
          }}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p className="auth__error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : null}
        <div className="auth__spacer" />
        <Button type="submit" block disabled={busy}>
          {busy ? "Sending…" : "Send code"}
        </Button>
        <p className="auth__fineprint">New here? The same code creates your account.</p>
      </form>
      <PhoneLinkEntry />
    </AuthLayout>
  );
}
