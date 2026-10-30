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

/**
 * Auto-lock counts only what the person does (owner decision, October 28, 2026): calls the app
 * makes on its own (on a timer, on coming back online or to the foreground, after a sync, or
 * to keep the server's copies current) carry this header, and the server does not count them
 * as activity. A call made by a person's tap or by a screen they opened stays on `api`.
 */
export const BACKGROUND_HEADER = "X-Qash-Background";

/** The same client for calls nobody asked for just now: they never keep the session awake. */
export const backgroundApi = createApiClient({
  baseUrl: apiOrigin(),
  headers: { [BACKGROUND_HEADER]: "1" },
  onAuthSignal: (signal) =>
    authEvents.dispatchEvent(new CustomEvent<AuthSignal>("auth", { detail: signal })),
});

/** `backgroundApi` when the app made the call on its own, else `api`. */
export function clientFor(background: boolean | undefined): typeof api {
  return background ? backgroundApi : api;
}

export function onAuthSignal(handler: (signal: AuthSignal) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<AuthSignal>).detail);
  authEvents.addEventListener("auth", listener);
  return () => authEvents.removeEventListener("auth", listener);
}

/**
 * No network (offline, or the server unreachable): the client answers status 0 rather than
 * throwing (`@stackd/api-client`), and failureOf() names it `offline` (invariant 35, October 29,
 * 2026). Every pending state ends on it, and a person-facing failure says this.
 */
export const OFFLINE_MESSAGE = "You're offline. Try again when connected.";

/**
 * After getting back in with only an email code, the most sensitive actions wait a day
 * (invariant 74): export, email change, linking a bank, replacing or turning off the backup.
 */
export const RECOVERY_HOLD_MESSAGE =
  "For your safety, this opens a day after getting back in without a passkey.";

/**
 * The offline message for a call that never reached the server, the day's hold after getting
 * back in, else the screen's own words.
 */
export function failureText(failure: ApiFailure, otherwise: string): string {
  if (failure.status === 0) return OFFLINE_MESSAGE;
  if (failure.code === "recently_recovered") return RECOVERY_HOLD_MESSAGE;
  return otherwise;
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
  if (result.response.status === 0) code = "offline";
  else if (typeof detail === "string") code = detail;
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
