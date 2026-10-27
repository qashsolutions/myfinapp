import { Button } from "@stackd/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { offerPasskeyHere } from "../security/PasskeyHereOffer.tsx";
import { AuthLayout } from "./AuthLayout.tsx";
import { linkUrl, type QrPath, qrPath } from "./linkQr.ts";
import { onComputer } from "./NoBiometricsHelp.tsx";
import { useSession } from "./useSession.tsx";

/** How often the computer asks whether the phone has answered. */
const POLL_MS = 2000;

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; code: string; expiresAt: number }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "limited" }
  | { kind: "failed" }
  | { kind: "approved" };

const STEPS = [
  ["Open Qash on your phone", "Me → Link a device"],
  ["Scan this code", "Or type the letters above"],
  ["Approve on your phone", "Face ID or fingerprint"],
] as const;

/**
 * "Link with your phone", the computer's half (owner decisions, October 19, 2026; spec "Signing
 * in on another device"): ask the server for a code, show it as a QR code and as letters, and
 * wait for a signed-in phone to approve. The server keeps the secret in an HttpOnly cookie only
 * this browser holds, so the code alone signs nobody in; it lasts 2 minutes, 3 an hour per IP.
 */
export function LinkWithPhone() {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [qr, setQr] = useState<QrPath | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    document.title = `Sign in with your phone · ${APP_NAME}`;
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: "starting" });
    setQr(null);
    const result = await api.POST("/api/auth/link/start");
    if (!alive.current) return;
    const failure = failureOf(result);
    if (failure || !result.data) {
      setPhase({ kind: failure?.code === "rate_limited" ? "limited" : "failed" });
      return;
    }
    const { code, expires_in_seconds } = result.data;
    setPhase({ kind: "waiting", code, expiresAt: Date.now() + expires_in_seconds * 1000 });
    try {
      const path = await qrPath(linkUrl(code));
      if (alive.current) setQr(path);
    } catch {
      // No QR code: the letters still work.
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  // Ask every 2 seconds while waiting; the server answers once with the session when approved.
  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const result = await api.GET("/api/auth/link/status");
      if (!alive.current) return;
      const answer = result.data?.status;
      if (answer === "approved") {
        setPhase({ kind: "approved" });
        offerPasskeyHere();
        await session.refresh();
        return;
      }
      if (answer === "denied") return setPhase({ kind: "denied" });
      if (answer === "expired" || result.response?.status === 404)
        return setPhase({ kind: "expired" });
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, session]);

  // The countdown, drawn as a ring; ending it locally saves asking the server once more.
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  const left = phase.kind === "waiting" ? Math.max(0, phase.expiresAt - now) : 0;
  useEffect(() => {
    if (phase.kind === "waiting" && left === 0 && now >= phase.expiresAt)
      setPhase({ kind: "expired" });
  }, [phase, left, now]);

  return (
    <AuthLayout back="/signin">
      <h1 className="auth__title">Sign in with your phone</h1>
      <p className="auth__lead">Signed in to {APP_NAME} on your phone? Approve this computer.</p>

      {phase.kind === "waiting" || phase.kind === "starting" ? (
        <div className="link__card sk-card">
          <div className="link__qr">
            {qr ? (
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                role="img"
                aria-label="QR code to scan with your phone"
                shapeRendering="crispEdges"
              >
                {/* Black on white in every look and mode: phone cameras read light-on-dark codes badly. */}
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.d} fill="#000" />
              </svg>
            ) : (
              <span className="link__qr-wait" aria-hidden="true" />
            )}
          </div>
          {phase.kind === "waiting" ? (
            <>
              <p className="link__code">
                <span aria-hidden="true">{phase.code}</span>
                <span className="sr-only">Code: {[...phase.code].join(" ")}</span>
              </p>
              <Countdown msLeft={left} />
            </>
          ) : (
            <p className="link__status">Getting a code…</p>
          )}
        </div>
      ) : null}

      <p className="link__status" role="status">
        {phase.kind === "waiting"
          ? "Waiting for your phone…"
          : phase.kind === "approved"
            ? "Approved. Signing you in…"
            : ""}
      </p>

      {phase.kind === "waiting" || phase.kind === "starting" ? (
        <ol className="nobio__steps">
          {STEPS.map(([t, d], i) => (
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
      ) : null}

      {phase.kind === "expired" || phase.kind === "denied" || phase.kind === "failed" ? (
        <div className="link__end sk-card" role="alert">
          <strong>
            {phase.kind === "expired"
              ? "That code expired"
              : phase.kind === "denied"
                ? "Your phone said no"
                : "We couldn't get a code"}
          </strong>
          <span>
            {phase.kind === "failed"
              ? "Check your connection and try again."
              : "Codes last 2 minutes. Get a new one when your phone is ready."}
          </span>
          <Button block onClick={() => void start()}>
            Show a new code
          </Button>
        </div>
      ) : null}

      {phase.kind === "limited" ? (
        <div className="link__end sk-card" role="alert">
          <strong>That's 3 codes this hour</strong>
          <span>For your safety, try again in an hour, or sign in with email now.</span>
        </div>
      ) : null}

      <div className="auth__spacer" />
      <p className="auth__fineprint">
        Not signed in on your phone? <Link to="/signin">Use email instead</Link>
      </p>
    </AuthLayout>
  );
}

/** Time left as a shrinking ring and m:ss; the ring is decoration, the text is read. */
function Countdown({ msLeft }: { msLeft: number }) {
  const total = 120_000;
  const secs = Math.ceil(msLeft / 1000);
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <p className="link__timer">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={r} fill="none" stroke="var(--c-line)" strokeWidth="3" />
        <circle
          cx="11"
          cy="11"
          r={r}
          fill="none"
          stroke={secs <= 20 ? "var(--c-warning)" : "var(--c-a1)"}
          strokeWidth="3"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, msLeft / total))}
          transform="rotate(-90 11 11)"
          strokeLinecap="round"
        />
      </svg>
      <span>
        Expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
      </span>
    </p>
  );
}

/** The way in, on a computer only (a phone is the one that approves): Welcome and Sign in. */
export function PhoneLinkEntry() {
  if (!onComputer()) return null;
  return (
    <Link to="/signin/phone" className="auth__link auth__phone-link">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="6"
          y="2"
          width="12"
          height="20"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Sign in with your phone
    </Link>
  );
}
