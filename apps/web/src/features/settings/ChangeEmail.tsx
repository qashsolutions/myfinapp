import "../auth/auth.css";
import "../groups/groups.css";

import { Button, Card } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf } from "../../data/api.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "../security/StepUpPrompt.tsx";

/** Change email: a code goes to the new address after a passkey check; the old one stays until then. */
export function ChangeEmail() {
  const navigate = useNavigate();
  const session = useSession();
  const stepUp = useStepUp();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code" | "done">("email");
  const [error, setError] = useState<string | null>(null);
  const current = session.info?.user?.email ?? "";

  async function sendCode() {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter the new email address.");
      return;
    }
    if (!(await stepUp.confirm("Changing your email"))) return;
    const r = await api.POST("/api/account/email/send", { body: { new_email: email.trim() } });
    const failure = failureOf(r);
    if (failure) {
      setError(
        failure.code === "email_taken"
          ? "That address already has an account."
          : failure.code === "same_email"
            ? "That's already your address."
            : failure.status === 429
              ? "Too many codes. Wait a minute."
              : "Couldn't send a code. Try again.",
      );
      return;
    }
    setStep("code");
  }

  async function verify() {
    setError(null);
    const r = await api.POST("/api/account/email/verify", {
      body: { new_email: email.trim(), code: code.trim() },
    });
    const failure = failureOf(r);
    if (failure) {
      setError(
        failure.code === "wrong_code"
          ? `That code isn't right${failure.attemptsLeft !== undefined ? ` (${failure.attemptsLeft} tries left)` : ""}.`
          : failure.code === "expired"
            ? "That code expired. Send a new one."
            : failure.code === "email_taken"
              ? "That address already has an account."
              : failure.code === "locked"
                ? "Too many wrong tries. Codes pause for 15 minutes."
                : failure.code === "rate_limited"
                  ? "Too many tries from this network. Wait a few minutes."
                  : "Couldn't verify the code. Try again.",
      );
      return;
    }
    await session.refresh();
    setStep("done");
  }

  return (
    <>
      <ScreenHeader title="Change email" actions={null} back="/me/account" />
      <Card>
        <p>
          Signed in as <strong>{current}</strong>. We'll send a code to the new address. Both
          addresses get a note.
        </p>
      </Card>
      {step === "email" ? (
        <>
          <label className="auth__field">
            <span className="auth__label">New email</span>
            <input
              className="auth__input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <Button block onClick={sendCode}>
            Send code
          </Button>
        </>
      ) : null}
      {step === "code" ? (
        <>
          <label className="auth__field">
            <span className="auth__label">Code sent to {email.trim()}</span>
            <input
              className="auth__input code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <Button block onClick={verify} disabled={code.length !== 6}>
            Verify and change
          </Button>
          <Button block variant="ghost" onClick={() => setStep("email")}>
            Use a different address
          </Button>
        </>
      ) : null}
      {step === "done" ? (
        <>
          <Card>
            <p role="status">Done. Your email is now {session.info?.user?.email}.</p>
          </Card>
          <Button block variant="secondary" onClick={() => navigate("/me/account")}>
            Back to Account & plan
          </Button>
        </>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
