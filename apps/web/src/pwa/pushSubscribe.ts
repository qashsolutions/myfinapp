/**
 * Web Push subscription (docs/spec.md "Notifications" → Delivery). The browser asks for
 * permission only after the in-app explainer; the subscription (endpoint + keys, nothing
 * else) goes to the server, which stores it encrypted. On iPhone this only works once the app
 * is on the Home Screen.
 */

import { api, failureOf } from "../data/api.ts";
import { isAppleMobile, isNativePlatform, isStandalone } from "../lib/platform.ts";
import { subscribeNativePush, unsubscribeNativePush } from "../native/push.ts";

export type PushOutcome =
  | "subscribed"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "needs_home_screen";

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
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function subscribeToPush(): Promise<PushOutcome> {
  if (isNativePlatform()) return subscribeNativePush(); // APNs / FCM via the shell (chunk 2.3)
  if (needsHomeScreen()) return "needs_home_screen";
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const key = await api.GET("/api/notifications/push/key");
  const publicKey = key.data?.public_key ?? null;
  if (!publicKey) return "unavailable";
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey).buffer as ArrayBuffer,
    }));
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) return "unavailable";
  const r = await api.POST("/api/notifications/push", {
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      user_agent: navigator.userAgent.slice(0, 120),
    },
  });
  return failureOf(r) ? "unavailable" : "subscribed";
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
