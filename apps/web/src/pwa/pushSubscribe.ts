/**
 * Web Push subscription (docs/spec.md "Notifications" → Delivery). The browser asks for
 * permission only after the in-app explainer; the subscription (endpoint + keys, nothing
 * else) goes to the server, which stores it encrypted. On iPhone this only works once the app
 * is on the Home Screen.
 */

import { api, failureOf, OFFLINE_MESSAGE } from "../data/api.ts";
import { APP_NAME } from "../lib/brand.ts";
import { isAppleMobile, isNativePlatform, isStandalone } from "../lib/platform.ts";
import { subscribeNativePush, unsubscribeNativePush } from "../native/push.ts";

/**
 * What turning push on came to. Every failure is one of these (invariant 63): nothing the
 * browser, the push service or the network does leaves the explainer waiting.
 * - `blocked`: the browser said no without asking (a private window, or the site already
 *   blocked in its settings); `denied`: the person answered Block; `dismissed`: the question
 *   was closed unanswered.
 * - `push_failed`: the browser's push service (or the shell's) refused or never answered.
 * - `offline` / `not_saved`: the subscription couldn't reach the server, or wasn't saved.
 * - `unavailable`: push isn't set up on the server.
 */
export type PushOutcome =
  | "subscribed"
  | "blocked"
  | "denied"
  | "dismissed"
  | "push_failed"
  | "offline"
  | "not_saved"
  | "unsupported"
  | "unavailable"
  | "needs_home_screen";

/** How long the service worker and the push service get before we say they didn't answer. */
export const PUSH_STEP_TIMEOUT_MS = 15_000;

/** The outcomes worth another tap of Turn on; the rest need something changed first. */
export const RETRYABLE_OUTCOMES: readonly PushOutcome[] = [
  "dismissed",
  "push_failed",
  "offline",
  "not_saved",
];

/** One plain message per outcome: what happened, and what to try. */
export function pushOutcomeText(outcome: PushOutcome): string {
  if (isNativePlatform() && (outcome === "denied" || outcome === "blocked"))
    return `Notifications are off for ${APP_NAME} in this device's settings. Turn them on there, then try again.`;
  switch (outcome) {
    case "subscribed":
      return "Notifications are on.";
    case "blocked":
      return "This browser didn't allow notifications. Private windows can't get them: try a normal window, or check the browser's site settings.";
    case "denied":
      return "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.";
    case "dismissed":
      return "The browser's question closed without an answer. Tap Turn on notifications to see it again.";
    case "push_failed":
      return "The browser's push service didn't answer. Try again in a minute. Private windows can't get notifications.";
    case "offline":
      return OFFLINE_MESSAGE;
    case "not_saved":
      return "Couldn't save this device for notifications. Try again in a minute.";
    case "needs_home_screen":
      return `On iPhone, add ${APP_NAME} to your Home Screen first (Me → Install ${APP_NAME}), then come back.`;
    case "unavailable":
      return "Push isn't set up on the server yet.";
    default:
      return "This browser can't receive notifications. Try another browser, or install the app.";
  }
}

/** `promise`'s answer, or `null` once `ms` pass without one. */
export function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A failed call to the server, as an outcome. */
export function serverOutcome(failure: { status: number; code: string }): PushOutcome {
  if (failure.code === "offline") return "offline";
  if (failure.code === "push_unavailable") return "unavailable";
  return "not_saved";
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iPhone Safari offers push only to installed apps; the native shell needs no install. */
export function needsHomeScreen(): boolean {
  if (isNativePlatform()) return false;
  return isAppleMobile() && !isStandalone();
}

function urlBase64ToBytes(value: string): Uint8Array {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await withinTime(navigator.serviceWorker.ready, PUSH_STEP_TIMEOUT_MS);
  return registration ? registration.pushManager.getSubscription() : null;
}

/** The permission the browser holds now; a browser that can't say reads as not asked. */
function permissionNow(): NotificationPermission {
  try {
    return Notification.permission ?? "default";
  } catch {
    return "default";
  }
}

/**
 * Asks for permission; a browser that throws or answers nothing reads as what it holds now.
 * Never timed (owner decision, October 29, 2026): the person takes as long as they like over
 * the browser's question; only the technical steps after it get PUSH_STEP_TIMEOUT_MS.
 */
async function askPermission(): Promise<NotificationPermission> {
  try {
    return (await Notification.requestPermission()) ?? permissionNow();
  } catch {
    return permissionNow();
  }
}

/**
 * Turns push on for this device and always comes back with an outcome (invariant 63): a throw
 * from the browser, a push service that never answers, or a failed call to the server is an
 * outcome the explainer says in plain words, never a stuck sheet.
 */
export async function subscribeToPush(): Promise<PushOutcome> {
  try {
    if (isNativePlatform()) return await subscribeNativePush(); // APNs / FCM via the shell
    if (needsHomeScreen()) return "needs_home_screen";
    if (!pushSupported()) return "unsupported";
    return await subscribeWebPush();
  } catch {
    return "push_failed";
  }
}

async function subscribeWebPush(): Promise<PushOutcome> {
  // A private window, or a site already blocked, answers "denied" without ever asking.
  const before = permissionNow();
  const permission = before === "denied" ? "denied" : await askPermission();
  if (permission !== "granted") {
    if (before === "denied") return "blocked";
    return permission === "denied" ? "denied" : "dismissed";
  }
  const key = await api.GET("/api/notifications/push/key");
  const keyFailure = failureOf(key);
  if (keyFailure) return serverOutcome(keyFailure);
  const publicKey = key.data?.public_key ?? null;
  if (!publicKey) return "unavailable";
  const registration = await withinTime(navigator.serviceWorker.ready, PUSH_STEP_TIMEOUT_MS);
  if (!registration) return "push_failed";
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await withinTime(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(publicKey).buffer as ArrayBuffer,
      }),
      PUSH_STEP_TIMEOUT_MS,
    ));
  if (!subscription) return "push_failed";
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) return "push_failed";
  const r = await api.POST("/api/notifications/push", {
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      user_agent: navigator.userAgent.slice(0, 120),
    },
  });
  const failure = failureOf(r);
  return failure ? serverOutcome(failure) : "subscribed";
}

export async function unsubscribeFromPush(): Promise<void> {
  if (isNativePlatform()) return unsubscribeNativePush();
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.POST("/api/notifications/push/unsubscribe", {
    body: { endpoint: subscription.endpoint },
  });
  await subscription.unsubscribe();
}
