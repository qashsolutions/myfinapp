import { Button } from "@stackd/ui";
import { useCallback, useEffect, useState } from "react";
import { Logo } from "../../app/layout/Logo.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { formatDateTime } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { PasskeyError, registerPasskey } from "./webauthn.ts";

type Recovery = {
  status: "none" | "waiting" | "ready";
  ready_at?: string | null;
  partner_available?: boolean;
  partner_asked?: boolean;
};

/** The code read out to the partner, kept for this tab so a reload doesn't lose it. */
const CODE_KEY = "qash.recovery_code";
function savedCode(): string | null {
  try {
    return sessionStorage.getItem(CODE_KEY);
  } catch {
    return null;
  }
}
function saveCode(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(CODE_KEY, code);
    else sessionStorage.removeItem(CODE_KEY);
  } catch {
    // private mode: the code shows until the page reloads
  }
}

/**
 * Getting back in without a passkey (owner decision, October 30, 2026; invariant 74). Shown on
 * the lock screen of a device signed in with an email code. Quickest first: another device
 * still signed in (Link with your phone), the household partner on the same plan, then 24
 * hours. Once ready, a new passkey here replaces the old ones.
 */
export function Recover({ onBack }: { onBack: () => void }) {
  const session = useSession();
  const [state, setState] = useState<Recovery | null>(null);
  const [code, setCodeState] = useState<string | null>(savedCode);
  const setCode = useCallback((value: string | null) => {
    saveCode(value);
    setCodeState(value);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.GET("/api/auth/recovery");
    if (r.response.status === 401) {
      void session.refresh(); // signed out here (finished on another device): the way in again
      return;
    }
    if (!r.data) return;
    const next = r.data as Recovery;
    if (next.status === "none" || !next.partner_asked) setCode(null);
    setState(next);
  }, [session, setCode]);

  useEffect(() => {
    void load();
  }, [load]);

  // Watch for the partner's approval (every 5 seconds) or the 24 hours (every minute).
  useEffect(() => {
    if (state?.status !== "waiting") return;
    const timer = setInterval(() => void load(), state.partner_asked ? 5_000 : 60_000);
    return () => clearInterval(timer);
  }, [state?.status, state?.partner_asked, load]);

  async function call(path: "/api/auth/recovery" | "/api/auth/recovery/cancel") {
    setBusy(true);
    setError(null);
    const r = await api.POST(path);
    setBusy(false);
    const failure = failureOf(r);
    if (failure) {
      setError(failureText(failure, "Couldn't reach Qash. Try again."));
      return null;
    }
    setState(r.data as Recovery);
    return r.data as Recovery;
  }

  async function askPartner() {
    setBusy(true);
    setError(null);
    const r = await api.POST("/api/auth/recovery/partner");
    setBusy(false);
    const failure = failureOf(r);
    if (failure) {
      setError(
        failure.code === "no_partner"
          ? "Your partner can't approve this right now. Wait the 24 hours instead."
          : failureText(failure, "Couldn't reach Qash. Try again."),
      );
      return;
    }
    await load();
    setCode(r.data?.code ?? null);
  }

  async function cancel() {
    if (await call("/api/auth/recovery/cancel")) {
      setCode(null);
      onBack();
    }
  }

  async function makePasskey() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey();
      setCode(null);
      await session.refresh();
    } catch (err) {
      setError(
        err instanceof PasskeyError && err.code === "cancelled"
          ? "Cancelled. Try again when you're ready."
          : err instanceof PasskeyError && err.message === "recovery_closed"
            ? "This was cancelled with your passkey, so nothing changed. Unlock with it instead."
            : "Couldn't create the passkey. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // The partner is never named here: whoever holds the email sees this screen too.
  const hasPartner = state?.partner_available === true;
  const shownCode = code ? `${code.slice(0, 3)} ${code.slice(3)}` : null;

  return (
    <div className="auth">
      <div className="auth__spacer" />
      <div className="auth__centre">
        <Logo size={64} />
        {state === null ? (
          <p className="auth__lead">Checking…</p>
        ) : state.status === "ready" ? (
          <>
            <h1 className="auth__title">You're ready</h1>
            <p className="auth__lead">
              Create a new passkey on this device. Your old passkeys stop working and your other
              devices are signed out.
            </p>
            <p className="auth__hint">
              Your data comes back from your encrypted backup, with your recovery key or a passkey
              that syncs, or from another device that's still signed in.
            </p>
          </>
        ) : state.status === "waiting" ? (
          <>
            <h1 className="auth__title">On its way</h1>
            {shownCode && hasPartner ? (
              <>
                <p className="auth__lead">Read this code to your partner:</p>
                <p className="recover__code">{shownCode}</p>
                <p className="auth__hint">
                  Your partner opens Qash, goes to Me, then Household, and types it in. You're in as
                  soon as they do. Asking again makes a new code.
                </p>
              </>
            ) : (
              <p className="auth__lead">
                You can create a new passkey here from{" "}
                {state.ready_at ? formatDateTime(state.ready_at) : "tomorrow"}. We've emailed you,
                and anyone signed in with your passkey can cancel it.
              </p>
            )}
            {state.partner_asked && !shownCode ? (
              <p className="auth__hint">Waiting for your partner to approve.</p>
            ) : null}
          </>
        ) : (
          <>
            <h1 className="auth__title">Get back in</h1>
            <p className="auth__lead">Lost every passkey? Here's the quickest way back.</p>
            <ul className="auth__points auth__points--bulleted">
              <li>
                Still signed in on another device? Sign out here, choose Link with your phone, and
                approve it on that device.
              </li>
              {hasPartner ? (
                <li>Your partner can let you in now, from their Qash.</li>
              ) : (
                <li>Otherwise you can create a new passkey here in 24 hours.</li>
              )}
            </ul>
          </>
        )}
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="auth__spacer" />
      <div className="auth__actions">
        {state?.status === "ready" ? (
          <Button block onClick={makePasskey} disabled={busy}>
            {busy ? "Waiting for your device…" : "Create a new passkey"}
          </Button>
        ) : null}
        {state && state.status !== "ready" && hasPartner && !shownCode ? (
          <Button block onClick={askPartner} disabled={busy}>
            Ask my partner to let me in
          </Button>
        ) : null}
        {state?.status === "none" ? (
          <Button
            block
            variant={hasPartner ? "secondary" : "primary"}
            onClick={() => void call("/api/auth/recovery")}
            disabled={busy}
          >
            Wait 24 hours
          </Button>
        ) : null}
        {state && state.status !== "none" ? (
          <Button block variant="ghost" onClick={cancel} disabled={busy}>
            I found my passkey
          </Button>
        ) : (
          <Button block variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
      </div>
    </div>
  );
}
