import "./link-device.css";

import { Button } from "@stackd/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { RequireAuth } from "../../app/RequireAuth.tsx";
import { api, failureOf, failureText, OFFLINE_MESSAGE } from "../../data/api.ts";
import { biometricName } from "../../lib/platform.ts";
import { AuthLayout } from "../auth/AuthLayout.tsx";
import { completeCode, tidyCode } from "../auth/linkCode.ts";
import { useSession } from "../auth/useSession.tsx";
import { canScan, QrScanner } from "./QrScanner.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";

interface Request {
  code: string;
  device: string;
  sameNetwork: boolean;
  expiresAt: number;
}

type Phase =
  | { kind: "enter"; scanning: boolean }
  | { kind: "checking" }
  | { kind: "review"; request: Request }
  | { kind: "approved"; device: string }
  | { kind: "denied" }
  | { kind: "gone" }
  | { kind: "limited" };

/**
 * /link: signed in, the approval screen; signed out, how to reach it. A QR code scanned with the
 * phone's own camera lands here in the browser, which on iPhone is not where the person is signed
 * in, so that case explains the way through the installed app with the code in view.
 */
export function LinkGate() {
  const { status } = useSession();
  if (status === "signed_out" || status === "needs_passkey") return <LinkSignedOut />;
  return <RequireAuth />;
}

/**
 * Link a device, the phone's half (B3; owner decisions, October 19, 2026): scan the computer's QR
 * code in the app or type its letters, see which browser and system asked, a warning when the two
 * are on different networks that must be confirmed, then a fresh passkey check and Approve. The
 * computer picks up its own session; nothing about this phone's data goes to it.
 */
export function LinkDevice() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const fieldId = useId();
  const fromUrl = completeCode(params.get("code") ?? "");
  const [phase, setPhase] = useState<Phase>(
    fromUrl ? { kind: "checking" } : { kind: "enter", scanning: false },
  );
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  async function lookup(code: string) {
    setError(null);
    setPhase({ kind: "checking" });
    const result = await api.POST("/api/auth/link/lookup", { body: { code } });
    const failure = failureOf(result);
    if (failure || !result.data) {
      if (failure?.code === "rate_limited") return setPhase({ kind: "limited" });
      if (failure?.code === "offline") {
        setError(OFFLINE_MESSAGE);
        return setPhase({ kind: "enter", scanning: false });
      }
      return setPhase({ kind: "gone" });
    }
    setMine(false);
    setPhase({
      kind: "review",
      request: {
        code,
        device: result.data.device_label,
        sameNetwork: result.data.same_network,
        expiresAt: Date.now() + result.data.expires_in_seconds * 1000,
      },
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a code in the address is looked up once
  useEffect(() => {
    if (fromUrl) void lookup(fromUrl);
  }, []);

  const reviewing = phase.kind === "review";
  useEffect(() => {
    if (!reviewing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [reviewing]);
  const left = phase.kind === "review" ? Math.max(0, phase.request.expiresAt - now) : 0;
  useEffect(() => {
    if (phase.kind === "review" && left === 0) setPhase({ kind: "gone" });
  }, [phase, left]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const code = completeCode(typed);
    if (!code) return setError("Codes are 8 letters and numbers, like ABCD-EFGH.");
    void lookup(code);
  }

  async function approve(request: Request) {
    setBusy(true);
    const ok = await stepUp.confirm(`Signing in ${request.device}`);
    if (!ok) return setBusy(false);
    const result = await api.POST("/api/auth/link/approve", {
      body: { code: request.code, confirm_different_network: !request.sameNetwork && mine },
    });
    setBusy(false);
    const failure = failureOf(result);
    if (!failure) return setPhase({ kind: "approved", device: request.device });
    if (failure.code === "different_network")
      return setPhase({ kind: "review", request: { ...request, sameNetwork: false } });
    // 404: no such request; 409: already answered or expired (each is answered once).
    if (failure.status === 404 || failure.status === 409) return setPhase({ kind: "gone" });
    setError(failureText(failure, "That didn't go through. Try again."));
  }

  async function deny(request: Request) {
    setBusy(true);
    const result = await api.POST("/api/auth/link/deny", { body: { code: request.code } });
    setBusy(false);
    const failure = failureOf(result);
    if (failure?.status === 404 || failure?.status === 409) return setPhase({ kind: "gone" });
    // Not said no until the server heard it: the computer would still be waiting.
    if (failure) return setError(failureText(failure, "That didn't go through. Try again."));
    setPhase({ kind: "denied" });
  }

  return (
    <>
      <ScreenHeader title="Link a device" back="/me" actions={null} />
      <div className="link-device">
        {phase.kind === "enter" ? (
          phase.scanning ? (
            <QrScanner
              onCode={(code) => void lookup(code)}
              onCancel={() => setPhase({ kind: "enter", scanning: false })}
            />
          ) : (
            <>
              <LinkArt />
              <p className="link-device__lead">
                Sign in on a computer with this phone. On the computer, choose{" "}
                <strong>Sign in with your phone</strong>.
              </p>
              {canScan() ? (
                <Button block onClick={() => setPhase({ kind: "enter", scanning: true })}>
                  Scan the code
                </Button>
              ) : null}
              <form className="link-device__form" onSubmit={submit} noValidate>
                <label className="auth__label" htmlFor={fieldId}>
                  Or type the code
                </label>
                <input
                  id={fieldId}
                  className="auth__input link-device__code"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ABCD-EFGH"
                  value={typed}
                  onChange={(e) => setTyped(tidyCode(e.target.value))}
                  aria-describedby={error ? `${fieldId}-error` : undefined}
                  aria-invalid={error ? true : undefined}
                />
                {error ? (
                  <p className="auth__error" id={`${fieldId}-error`} role="alert">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" variant="secondary" block>
                  Continue
                </Button>
              </form>
            </>
          )
        ) : null}

        {phase.kind === "checking" ? (
          <p className="link-device__lead" role="status">
            Checking the code…
          </p>
        ) : null}

        {phase.kind === "review" ? (
          <>
            <div className="link-device__ask sk-card">
              <LaptopIcon />
              <h2 className="link-device__title">Sign in on this computer?</h2>
              <p className="link-device__device">{phase.request.device}</p>
              <p className="link-device__expires">
                Expires in {Math.floor(Math.ceil(left / 1000) / 60)}:
                {String(Math.ceil(left / 1000) % 60).padStart(2, "0")}
              </p>
            </div>
            {phase.request.sameNetwork ? null : (
              <div className="link-device__warn sk-card" role="alert">
                <strong>It's on a different network</strong>
                <span>
                  This computer isn't on the same Wi-Fi as your phone. Approve only if it's yours
                  and you're using it right now.
                </span>
                <label className="link-device__check">
                  <input
                    type="checkbox"
                    checked={mine}
                    onChange={(e) => setMine(e.target.checked)}
                  />
                  It's my computer, and I'm using it now
                </label>
              </div>
            )}
            {error ? (
              <p className="auth__error" role="alert">
                {error}
              </p>
            ) : null}
            <p className="link-device__never">
              Never approve a code someone sent you or read out to you.
            </p>
            <div className="link-device__actions">
              <Button
                block
                disabled={busy || (!phase.request.sameNetwork && !mine)}
                onClick={() => void approve(phase.request)}
              >
                Approve with {biometricName()}
              </Button>
              <Button
                variant="secondary"
                block
                disabled={busy}
                onClick={() => void deny(phase.request)}
              >
                No, deny
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === "approved" ||
        phase.kind === "denied" ||
        phase.kind === "gone" ||
        phase.kind === "limited" ? (
          <div className={`link-device__end sk-card link-device__end--${phase.kind}`} role="status">
            <strong>
              {phase.kind === "approved"
                ? "Approved"
                : phase.kind === "denied"
                  ? "Denied"
                  : phase.kind === "gone"
                    ? "That code has expired"
                    : "Too many tries"}
            </strong>
            <span>
              {phase.kind === "approved"
                ? `${phase.device} is signing in now. We've emailed you about it.`
                : phase.kind === "denied"
                  ? "Nobody was signed in."
                  : phase.kind === "gone"
                    ? "Or it was already used. Get a new one on the computer."
                    : "Wait a few minutes, then try again."}
            </span>
            {phase.kind === "gone" ? (
              <Button
                block
                onClick={() => {
                  setTyped("");
                  setPhase({ kind: "enter", scanning: false });
                }}
              >
                Enter a new code
              </Button>
            ) : (
              <Button variant="secondary" block onClick={() => navigate("/me")}>
                Done
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Reached /link signed out: most often the phone's Camera app opened the code in the browser. */
function LinkSignedOut() {
  const [params] = useSearchParams();
  const code = completeCode(params.get("code") ?? "");
  return (
    <AuthLayout brand>
      <h1 className="auth__title">Approve in the Qash app</h1>
      <p className="auth__lead">You're not signed in here. Use the app where you are.</p>
      <ol className="nobio__steps">
        {(
          [
            ["Open Qash", "From your Home Screen"],
            ["Go to Me → Link a device", "Then type the code"],
            ["Approve the computer", "Face ID or fingerprint"],
          ] as const
        ).map(([t, d], i) => (
          <li key={t}>
            <span className="nobio__n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <strong>{t}</strong>
              <span>{d}</span>
            </span>
          </li>
        ))}
      </ol>
      {code ? (
        <p className="link__code link-device__shown">
          <span aria-hidden="true">{code}</span>
          <span className="sr-only">Code: {[...code].join(" ")}</span>
        </p>
      ) : null}
      <div className="auth__spacer" />
      <p className="auth__fineprint">
        Not signed in on this phone at all? <Link to="/welcome">Sign in first</Link>
      </p>
    </AuthLayout>
  );
}

function LaptopIcon() {
  return (
    <svg
      className="link-device__icon"
      viewBox="0 0 48 48"
      width="48"
      height="48"
      aria-hidden="true"
    >
      <rect
        x="9"
        y="10"
        width="30"
        height="20"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path d="M4 36h40" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A phone pointing at a computer's code: the whole idea in one picture. */
function LinkArt() {
  return (
    <svg className="link-device__art" viewBox="0 0 280 120" aria-hidden="true">
      <rect x="20" y="16" width="130" height="80" rx="8" fill="var(--c-ink)" />
      <rect x="26" y="22" width="118" height="68" rx="4" fill="var(--c-card)" />
      <rect x="66" y="32" width="38" height="38" rx="3" fill="var(--c-ink)" />
      <rect x="72" y="38" width="10" height="10" fill="var(--c-card)" />
      <rect x="88" y="38" width="10" height="10" fill="var(--c-card)" />
      <rect x="72" y="54" width="10" height="10" fill="var(--c-card)" />
      <rect x="90" y="56" width="6" height="6" fill="var(--c-card)" />
      <path d="M8 100h154l-8 10H16z" fill="var(--c-ink)" opacity="0.85" />
      <path d="M160 58h36" stroke="var(--c-a1)" strokeWidth="3" strokeDasharray="6 5" />
      <rect x="200" y="20" width="56" height="96" rx="12" fill="var(--c-a1)" />
      <rect x="205" y="26" width="46" height="84" rx="8" fill="var(--c-card)" />
      <circle cx="228" cy="80" r="11" fill="var(--c-success)" />
      <path
        d="M223 80l4 4 7-8"
        fill="none"
        stroke="var(--c-on-accent)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="215"
        y="38"
        width="26"
        height="26"
        rx="4"
        fill="none"
        stroke="var(--c-a1)"
        strokeWidth="2"
        strokeDasharray="6 4"
      />
    </svg>
  );
}
