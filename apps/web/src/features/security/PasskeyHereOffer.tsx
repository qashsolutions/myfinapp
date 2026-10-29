import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { biometricName } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";
import { PasskeyError, passkeysSupported, registerPasskey } from "./webauthn.ts";

const KEY = "stackd.offer_passkey_here";

/** Set by the computer's "Sign in with your phone" once the phone approves (B2). Per tab. */
export function offerPasskeyHere(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // storage blocked: the offer just doesn't appear; Me → Sign-in & security still adds one
  }
}

function pending(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function clear(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/** Only where this device can make its own passkey (Touch ID, Windows Hello, a phone's lock). */
async function canMakeOne(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * B4 (owner decision, October 19, 2026: offered, not required): right after a computer is signed
 * in by the phone, offer this computer its own passkey, so next time it signs in by itself with
 * Touch ID or Windows Hello. Asked once; "Not now" or closing it never asks again in this tab.
 *
 * The phone's approval is not a passkey check on this computer (invariant 44, owner decision,
 * October 29, 2026), so adding one asks for that check first: the browser offers the phone's
 * passkey ("use a phone", a QR code to scan). This sheet steps aside while it runs.
 */
export function PasskeyHereOffer() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"ask" | "busy" | "done" | "error">("ask");
  const bio = biometricName();
  const stepUp = useStepUp();
  const session = useSession();
  const checkedHere = Boolean(session.info?.passkey_verified_at);

  useEffect(() => {
    if (!pending()) return;
    let alive = true;
    void canMakeOne().then((ok) => {
      if (!alive) return;
      if (ok) setOpen(true);
      else clear();
    });
    return () => {
      alive = false;
    };
  }, []);

  function close() {
    clear();
    setOpen(false);
  }

  async function create() {
    // The check on this computer comes first; the step-up sheet takes the screen meanwhile.
    setOpen(false);
    const ok = await stepUp.confirm(`Setting up ${bio} here`);
    setOpen(true);
    if (!ok) return;
    setState("busy");
    try {
      await registerPasskey();
      clear();
      setState("done");
    } catch (err) {
      setState(err instanceof PasskeyError && err.code === "cancelled" ? "ask" : "error");
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={state === "done" ? "All set" : `Use ${bio} here next time?`}
    >
      {state === "done" ? (
        <>
          <p className="auth__lead">
            Next time, sign in on this computer with {bio}. No phone needed.
          </p>
          <Button block onClick={close}>
            Done
          </Button>
        </>
      ) : (
        <>
          <p className="auth__lead">Skip the phone next time. One touch signs you in here.</p>
          {checkedHere ? null : (
            <p className="auth__hint">First, a quick check that it's you, with your phone.</p>
          )}
          {state === "error" ? (
            <p className="auth__error" role="alert">
              That didn't work. Try again, or add one later in Me → Sign-in &amp; security.
            </p>
          ) : null}
          <Button block disabled={state === "busy"} onClick={() => void create()}>
            {state === "busy" ? "Waiting…" : `Set up ${bio}`}
          </Button>
          <Button variant="secondary" block onClick={close}>
            Not now
          </Button>
          <p className="auth__fineprint">
            Only for a computer you use. Not a shared or public one.
          </p>
        </>
      )}
    </Sheet>
  );
}
