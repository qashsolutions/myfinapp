/**
 * Passkeys inside the native shells (Face ID / fingerprint sign-in; Phase 2, chunk 2.3; spec
 * `biometrics.ts`). WKWebView cannot run a WebAuthn ceremony from the capacitor:// origin, so
 * the iOS project registers a `StackdPasskeys` plugin on ASAuthorization (and Android one on
 * Credential Manager, where the WebView lacks it); apps/mobile/README.md carries the contract.
 *
 * The contract: `create` / `get` take `{ optionsJSON }`, the server's publicKey options as
 * JSON exactly as the options routes return it, and resolve
 * `{ credentialJSON }` shaped exactly like @simplewebauthn/browser's output, so the server
 * verifies both paths identically (`webauthn.ts` routes here when the plugin exists). A
 * cancelled prompt rejects with `{ name: "NotAllowedError" }`, which webauthn.ts already
 * classifies as cancelled. The PRF extension's output, when present, rides inside
 * `clientExtensionResults.prf.results.first` as base64url and is stripped on the device like
 * the browser path's.
 */

import { nativePlugin } from "../lib/platform.ts";

interface StackdPasskeysPlugin {
  create(args: { optionsJSON: string }): Promise<{ credentialJSON: string }>;
  get(args: { optionsJSON: string }): Promise<{ credentialJSON: string }>;
}

export function nativePasskeysAvailable(): boolean {
  return nativePlugin("StackdPasskeys") !== null;
}

export async function nativeCreateCredential(options: unknown): Promise<unknown> {
  const plugin = nativePlugin<StackdPasskeysPlugin>("StackdPasskeys");
  if (!plugin) throw new Error("native passkeys are not available");
  const { credentialJSON } = await plugin.create({ optionsJSON: JSON.stringify(options) });
  return JSON.parse(credentialJSON);
}

export async function nativeGetCredential(options: unknown): Promise<unknown> {
  const plugin = nativePlugin<StackdPasskeysPlugin>("StackdPasskeys");
  if (!plugin) throw new Error("native passkeys are not available");
  const { credentialJSON } = await plugin.get({ optionsJSON: JSON.stringify(options) });
  return JSON.parse(credentialJSON);
}
