/**
 * The one API client. Same-origin `/api/...` with the session cookie; the dev server and the
 * production proxy both forward it to services/api. Auth signals from any response
 * (sign_in_required, locked, step_up_required) are broadcast so the session store reacts
 * wherever the call came from.
 */

import { type AuthSignal, type components, createApiClient } from "@stackd/api-client";
import { isNativePlatform } from "../lib/platform.ts";

export type SessionInfo = components["schemas"]["SessionInfo"];
export type PasskeyOut = components["schemas"]["PasskeyOut"];
export type DeviceOut = components["schemas"]["DeviceOut"];
export type ActivityOut = components["schemas"]["ActivityOut"];
export type GroupSummary = components["schemas"]["GroupSummary"];
export type GroupDetail = components["schemas"]["GroupDetail"];
export type GroupPreview = components["schemas"]["GroupPreview"];
export type GroupMemberOut = components["schemas"]["MemberOut"];
export type AccountOut = components["schemas"]["AccountOut"];
export type ExportOut = components["schemas"]["ExportOut"];
export type NotificationSettingsOut = components["schemas"]["SettingsOut"];
export type NotificationSettingsPatch = components["schemas"]["SettingsPatch"];

export const authEvents = new EventTarget();

/**
 * Where the API lives: the page's own origin, which the PWA shares with it. Inside a native
 * shell (Phase 2) the page is served from the app's host on a local scheme, so the API is that
 * host over https; the host itself comes from the shell's config, never from here.
 */
export function apiOrigin(): string {
  const location = globalThis.location;
  if (!location) return "";
  if (isNativePlatform()) return `https://${location.hostname}`;
  return location.origin;
}

export const api = createApiClient({
  // Absolute so that Request() also works outside a browser (tests).
  baseUrl: apiOrigin(),
  onAuthSignal: (signal) =>
    authEvents.dispatchEvent(new CustomEvent<AuthSignal>("auth", { detail: signal })),
});

export function onAuthSignal(handler: (signal: AuthSignal) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<AuthSignal>).detail);
  authEvents.addEventListener("auth", listener);
  return () => authEvents.removeEventListener("auth", listener);
}

/** The server's error `detail`, which is a string code or {code, ...} for our own errors. */
export interface ApiFailure {
  status: number;
  code: string;
  attemptsLeft?: number;
  retryAfter?: number;
}

export function failureOf(result: { error?: unknown; response: Response }): ApiFailure | null {
  if (result.response.ok) return null;
  const detail = (result.error as { detail?: unknown } | undefined)?.detail;
  let code = "error";
  let attemptsLeft: number | undefined;
  if (typeof detail === "string") code = detail;
  else if (detail && typeof detail === "object" && "code" in detail) {
    code = String((detail as { code: unknown }).code);
    const left = (detail as { attempts_left?: unknown }).attempts_left;
    if (typeof left === "number") attemptsLeft = left;
  } else if (result.response.status === 422) code = "invalid";
  const retry = result.response.headers.get("retry-after");
  return {
    status: result.response.status,
    code,
    attemptsLeft,
    retryAfter: retry ? Number(retry) : undefined,
  };
}
