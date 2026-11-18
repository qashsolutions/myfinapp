/**
 * Web Push subscription (docs/spec.md "Notifications" → Delivery). The browser asks for
 * permission only after the in-app explainer; the subscription (endpoint + keys, nothing
 * else) goes to the server, which stores it encrypted. On iPhone this only works once the app
 * is on the Home Screen.
 */

import { api, clientFor, failureOf, OFFLINE_MESSAGE } from "../data/api.ts";
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

/**
 * Whether this browser itself holds a push subscription (invariant 93): the account may have
 * push in another browser, which this one can neither show as its own nor turn off. `null` in
 * the native shell, whose token the server's answer already describes.
 */
export async function pushOnHere(): Promise<boolean | null> {
  if (isNativePlatform()) return null;
  return (await currentSubscription()) !== null;
}

/**
 * Whether `subscription` was made with `publicKey`; `null` when the browser doesn't say. A
 * subscription under an older VAPID key is refused by the push service for every send.
 */
function madeWithKey(subscription: PushSubscription, publicKey: string): boolean | null {
  const held = subscription.options?.applicationServerKey;
  if (!held) return null;
  const a = new Uint8Array(held);
  const b = urlBase64ToBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Ends a subscription on the server and in the browser; a failure on either is let go. */
async function dropSubscription(
  subscription: PushSubscription,
  client: Pick<typeof api, "POST">,
): Promise<void> {
  try {
    await client.POST("/api/notifications/push/unsubscribe", {
      body: { endpoint: subscription.endpoint },
    });
  } catch {
    // the server forgets it anyway once the push service answers 404 / 410
  }
  try {
    await subscription.unsubscribe();
  } catch {
    // nothing more to do: the next subscribe makes a new one
  }
}

/** This browser's subscription to send, made under `publicKey`: kept, or made afresh. */
async function subscriptionFor(
  registration: ServiceWorkerRegistration,
  publicKey: string,
  client: Pick<typeof api, "POST">,
): Promise<PushSubscription | null> {
  const held = await registration.pushManager.getSubscription();
  if (held && madeWithKey(held, publicKey) !== false) return held;
  if (held) await dropSubscription(held, client);
  return withinTime(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey).buffer as ArrayBuffer,
    }),
    PUSH_STEP_TIMEOUT_MS,
  );
}

/** The subscription's endpoint and keys to the server; the outcome of saving them. */
async function register(
  subscription: PushSubscription,
  client: Pick<typeof api, "POST">,
): Promise<PushOutcome> {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) return "push_failed";
  const r = await client.POST("/api/notifications/push", {
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      user_agent: navigator.userAgent.slice(0, 120),
    },
  });
  const failure = failureOf(r);
  return failure ? serverOutcome(failure) : "subscribed";
}

/**
 * On opening the app (invariant 93): a browser whose push was made under a VAPID key the
 * server no longer uses gets a new subscription under the current one, without asking again
 * (the permission is already granted). Nothing happens where push was never on.
 */
export async function renewPushKey(): Promise<boolean> {
  try {
    if (isNativePlatform() || !pushSupported() || permissionNow() !== "granted") return false;
    const registration = await withinTime(navigator.serviceWorker.ready, PUSH_STEP_TIMEOUT_MS);
    if (!registration) return false;
    const held = await registration.pushManager.getSubscription();
    if (!held) return false;
    const client = clientFor(true);
    const key = await client.GET("/api/notifications/push/key");
    const publicKey = failureOf(key) ? null : (key.data?.public_key ?? null);
    if (!publicKey || madeWithKey(held, publicKey) !== false) return false;
    const fresh = await subscriptionFor(registration, publicKey, client);
    return fresh !== null && (await register(fresh, client)) === "subscribed";
  } catch {
    return false;
  }
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
  const subscription = await subscriptionFor(registration, publicKey, api);
  if (!subscription) return "push_failed";
  return register(subscription, api);
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
