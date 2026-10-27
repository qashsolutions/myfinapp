/**
 * Passkeys in the browser. The server builds the options and verifies the answers
 * (services/api app/services/webauthn.py); this file only runs the ceremony.
 */

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { api, failureOf, type PasskeyOut } from "../../data/api.ts";
import {
  nativeCreateCredential,
  nativeGetCredential,
  nativePasskeysAvailable,
} from "../../native/biometrics.ts";

export class PasskeyError extends Error {
  constructor(
    public readonly code: "cancelled" | "unsupported" | "no_passkeys" | "invalid" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

let phoneNext = false;

/**
 * "Show the QR code" (October 14, 2026): the next passkey ceremony asks the browser to go
 * straight to its phone option (WebAuthn hint "hybrid": Chrome and Edge open the QR code;
 * other browsers ignore the hint and show their usual choice, which includes the phone).
 */
export function preferPhoneNext(): void {
  phoneNext = true;
}

function withHints(options: unknown): unknown {
  if (!phoneNext) return options;
  phoneNext = false;
  return { ...(options as Record<string, unknown>), hints: ["hybrid"] };
}

export function passkeysSupported(): boolean {
  // Inside a shell the StackdPasskeys plugin runs the ceremony (Face ID / fingerprint);
  // WKWebView has no WebAuthn of its own (chunk 2.3, native/biometrics.ts).
  return nativePasskeysAvailable() || browserSupportsWebAuthn();
}

function classify(err: unknown): PasskeyError {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return new PasskeyError("cancelled", "The passkey check was cancelled or timed out.");
  }
  if (name === "InvalidStateError") {
    return new PasskeyError("invalid", "This passkey already exists on this device.");
  }
  return new PasskeyError("failed", "The passkey check didn't complete.");
}

/** Create a passkey on this device and attach it to the signed-in account. */
export async function registerPasskey(label?: string): Promise<PasskeyOut> {
  if (!passkeysSupported())
    throw new PasskeyError("unsupported", "This browser can't create passkeys.");
  const opts = await api.POST("/api/security/passkeys/register/options");
  if (!opts.data) throw new PasskeyError("failed", failureOf(opts)?.code ?? "failed");
  let credential: Awaited<ReturnType<typeof startRegistration>>;
  try {
    credential = nativePasskeysAvailable()
      ? ((await nativeCreateCredential(opts.data.options)) as typeof credential)
      : // biome-ignore lint/suspicious/noExplicitAny: the server emits spec-shaped JSON; the library types are stricter than the wire format
        await startRegistration({ optionsJSON: withHints(opts.data.options) as any });
  } catch (err) {
    throw classify(err);
  }
  const result = await api.POST("/api/security/passkeys/register/verify", {
    body: { credential: credential as unknown as Record<string, never>, label: label ?? null },
  });
  if (!result.data) throw new PasskeyError("failed", failureOf(result)?.code ?? "failed");
  return result.data;
}

/** Prove the passkey (unlock, step-up). Resolves with the server's passkey_verified_at. */
export async function assertPasskey(purpose: "unlock" | "step_up" | "sign_in"): Promise<string> {
  return (await assertPasskeyWithPrf(purpose, null)).verifiedAt;
}

export interface PasskeyAssertion {
  verifiedAt: string;
  /** The PRF extension's output for the salt, when the authenticator supports it; never sent. */
  prf: Uint8Array | null;
  credentialId: string | null;
}

function base64urlToBytes(text: string): Uint8Array {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The same ceremony, asking for the PRF extension with `prfSalt` (chunk 1.16: the backup key
 * is wrapped under its output). The output is read here and stripped before the credential
 * goes to the server, so the server never sees it.
 */
export async function assertPasskeyWithPrf(
  purpose: "unlock" | "step_up" | "sign_in",
  prfSalt: Uint8Array | null,
): Promise<PasskeyAssertion> {
  if (!passkeysSupported())
    throw new PasskeyError("unsupported", "This browser can't use passkeys.");
  const body: { purpose: typeof purpose; prf_salt?: string } = { purpose };
  if (prfSalt) {
    let binary = "";
    for (const b of prfSalt) binary += String.fromCharCode(b);
    body.prf_salt = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const opts = await api.POST("/api/security/passkeys/assert/options", { body });
  if (!opts.data) {
    const failure = failureOf(opts);
    if (failure?.code === "no_passkeys")
      throw new PasskeyError("no_passkeys", "No passkey on this account yet.");
    throw new PasskeyError("failed", failure?.code ?? "failed");
  }
  let credential: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    credential = nativePasskeysAvailable()
      ? ((await nativeGetCredential(opts.data.options)) as typeof credential)
      : // biome-ignore lint/suspicious/noExplicitAny: same as above
        await startAuthentication({ optionsJSON: withHints(opts.data.options) as any });
  } catch (err) {
    throw classify(err);
  }
  let prf: Uint8Array | null = null;
  const ext = (
    credential as { clientExtensionResults?: { prf?: { results?: { first?: unknown } } } }
  ).clientExtensionResults;
  const first = ext?.prf?.results?.first;
  if (first instanceof ArrayBuffer) prf = new Uint8Array(first);
  else if (typeof first === "string") prf = base64urlToBytes(first);
  if (ext?.prf) {
    // The PRF output stays on this device.
    const { prf: _dropped, ...rest } = ext;
    (credential as { clientExtensionResults?: unknown }).clientExtensionResults = rest;
  }
  const result = await api.POST("/api/security/passkeys/assert/verify", {
    body: { credential: credential as unknown as Record<string, never> },
  });
  if (!result.data) throw new PasskeyError("invalid", "That didn't match. Try again.");
  return {
    verifiedAt: result.data.passkey_verified_at,
    prf,
    credentialId: typeof credential.id === "string" ? credential.id : null,
  };
}

/**
 * Sign in with a passkey the device already holds (October 13, 2026): no email, no code. The
 * device shows its own picker (iCloud Keychain, Google Password Manager, a security key); the
 * server finds the account from the passkey, signs in and unlocks in one step.
 */
export async function signInWithPasskey(displayMode: "browser" | "standalone"): Promise<void> {
  if (!passkeysSupported())
    throw new PasskeyError("unsupported", "This browser can't use passkeys.");
  const opts = await api.POST("/api/auth/passkey/options");
  if (!opts.data) throw new PasskeyError("failed", failureOf(opts)?.code ?? "failed");
  let credential: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    credential = nativePasskeysAvailable()
      ? ((await nativeGetCredential(opts.data.options)) as typeof credential)
      : // biome-ignore lint/suspicious/noExplicitAny: the server emits spec-shaped JSON
        await startAuthentication({ optionsJSON: withHints(opts.data.options) as any });
  } catch (err) {
    throw classify(err);
  }
  const result = await api.POST("/api/auth/passkey/verify", {
    body: {
      credential: credential as unknown as Record<string, never>,
      display_mode: displayMode,
    },
  });
  if (!result.data) {
    const code = failureOf(result)?.code;
    throw new PasskeyError(
      code === "unknown_credential" ? "no_passkeys" : "failed",
      code === "unknown_credential"
        ? "That passkey isn't linked to a Qash account."
        : "The passkey check didn't complete.",
    );
  }
}

/**
 * The passkey suggestion in the email box (October 19, 2026): asks the browser, quietly, for a
 * passkey it can offer in the email field's autofill list. Resolves true once the person picked
 * one and is signed in; false when the browser can't do this, the native shell handles passkeys
 * itself, or the request was cancelled (they asked for an email code instead). Uses the same
 * sign-in routes as "Sign in with a passkey"; nothing new on the server.
 */
export async function armPasskeyAutofill(displayMode: "browser" | "standalone"): Promise<boolean> {
  if (nativePasskeysAvailable() || !browserSupportsWebAuthn()) return false;
  if (!(await browserSupportsWebAuthnAutofill())) return false;
  const opts = await api.POST("/api/auth/passkey/options");
  if (!opts.data) return false;
  let credential: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    credential = await startAuthentication({
      // biome-ignore lint/suspicious/noExplicitAny: the server emits spec-shaped JSON
      optionsJSON: opts.data.options as any,
      useBrowserAutofill: true,
    });
  } catch {
    return false; // cancelled, or the request lapsed: the email path is still there
  }
  const result = await api.POST("/api/auth/passkey/verify", {
    body: {
      credential: credential as unknown as Record<string, never>,
      display_mode: displayMode,
    },
  });
  return Boolean(result.data);
}

/** Stops a pending autofill request (before the email code is sent, or when leaving). */
export function cancelPasskeyAutofill(): void {
  WebAuthnAbortService.cancelCeremony();
}
