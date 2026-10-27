import { Button, Chip } from "@stackd/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { mmss } from "../../lib/dates.ts";
import { isStandalone } from "../../lib/platform.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { CodeInput } from "./CodeInput.tsx";
import type { CodeScreenState } from "./SignIn.tsx";
import { useSession } from "./useSession.tsx";

/** OTP entry (mockup F1Code): code input, resend timer, paste support. */
export function OtpEntry() {
  const { state } = useLocation() as { state: CodeScreenState | null };
  const navigate = useNavigate();
  const session = useSession();
  const id = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resendIn, setResendIn] = useState(state?.resendAfter ?? 60);

  useEffect(() => {
    document.title = `Check your email · ${APP_NAME}`;
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  if (!state?.email) return <Navigate to="/signin" replace />;
  const email = state.email;

  async function resend() {
    const result = await api.POST("/api/auth/otp/send", { body: { email } });
    const failure = failureOf(result);
    setResendIn(failure?.retryAfter ?? result.data?.resend_after_seconds ?? 60);
    setCode("");
    setError(
      failure && failure.code === "locked"
        ? "Too many wrong tries. Codes pause for 15 minutes."
        : null,
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const result = await api.POST("/api/auth/otp/verify", {
      body: { email, code, display_mode: isStandalone() ? "standalone" : "browser" },
    });
    setBusy(false);
    const failure = failureOf(result);
    if (!failure) {
      setVerified(true);
      const info = await session.refresh();
      navigate(info?.has_passkeys ? "/" : "/signup/passkey", { replace: true });
      return;
    }
    setCode("");
    if (failure.code === "wrong_code") {
      const left = failure.attemptsLeft ?? 0;
      setError(`That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`);
    } else if (failure.code === "locked") {
      setError("Too many wrong tries. Codes pause for 15 minutes.");
    } else if (failure.code === "rate_limited") {
      setError("Too many tries from this network. Wait a few minutes, then try again.");
    } else if (failure.code === "expired" || failure.code === "no_code") {
      setError("That code has expired. Send a new one.");
    } else {
      setError("Something went wrong. Try again.");
    }
  }

  return (
    <AuthLayout back="/signin">
      <h1 className="auth__title">Check your email</h1>
      <p className="auth__lead" id={`${id}-lead`}>
        Enter the 6-digit code we sent to <strong>{email}</strong>. It expires in{" "}
        {Math.round((state.expiresIn ?? 600) / 60)} minutes.
      </p>
      <form onSubmit={submit} className="auth__field" noValidate>
        <CodeInput
          value={code}
          onChange={setCode}
          disabled={busy || verified}
          describedBy={`${id}-lead`}
        />
        {verified ? <Chip tone="success">Code verified</Chip> : null}
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="auth__hint">
          Didn't get it? Check spam, or{" "}
          {resendIn > 0 ? (
            <>
              resend in <strong>{mmss(resendIn)}</strong>
            </>
          ) : (
            <button type="button" className="auth__link" onClick={resend}>
              resend the code
            </button>
          )}
        </p>
        <button type="button" className="auth__link" onClick={() => navigate("/signin")}>
          Wrong email? Change it
        </button>
        <div className="auth__spacer" />
        <Button type="submit" block disabled={code.length !== 6 || busy || verified}>
          {busy ? "Checking…" : "Continue"}
        </Button>
        <p className="auth__fineprint">After 5 wrong tries, codes pause for 15 minutes.</p>
      </form>
    </AuthLayout>
  );
}
