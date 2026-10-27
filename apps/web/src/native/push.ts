/**
 * Native push registration (Phase 2, chunk 2.3; spec `push.ts`): APNs on iOS, FCM on Android,
 * through the shell's PushNotifications plugin. Only the platform and the device token go to
 * the server (`POST /api/notifications/push/native`), which stores them encrypted; the same
 * preferences, quiet hours and generic labels apply as on the web. The token is remembered in
 * localStorage so "Turn off on this device" can release exactly this device.
 */

import { api, failureOf } from "../data/api.ts";
import { nativePlatform, nativePlugin } from "../lib/platform.ts";
import type { PushOutcome } from "../pwa/pushSubscribe.ts";

interface PushNotificationsPlugin {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(
    event: "registration" | "registrationError",
    cb: (data: { value?: string }) => void,
  ): unknown;
}

const TOKEN_KEY = "stackd.push_token";
const REGISTER_TIMEOUT_MS = 10_000;

function rememberToken(platform: string, token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, JSON.stringify({ platform, token }));
  } catch {
    /* private mode: unsubscribe will simply have nothing to release */
  }
}

function rememberedToken(): { platform: "ios" | "android"; token: string } | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { platform?: string; token?: string };
    if ((parsed.platform === "ios" || parsed.platform === "android") && parsed.token)
      return { platform: parsed.platform, token: parsed.token };
    return null;
  } catch {
    return null;
  }
}

export async function subscribeNativePush(): Promise<PushOutcome> {
  const plugin = nativePlugin<PushNotificationsPlugin>("PushNotifications");
  const platform = nativePlatform();
  if (!plugin || !platform) return "unsupported";
  const permission = await plugin.requestPermissions();
  if (permission.receive !== "granted") return "denied";
  const token = await new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    plugin.addListener("registration", (data) => done(data.value ?? null));
    plugin.addListener("registrationError", () => done(null));
    setTimeout(() => done(null), REGISTER_TIMEOUT_MS);
    void plugin.register();
  });
  if (!token) return "unavailable";
  const r = await api.POST("/api/notifications/push/native", {
    body: { platform, token, user_agent: navigator.userAgent.slice(0, 120) },
  });
  if (failureOf(r)) return "unavailable";
  rememberToken(platform, token);
  return "subscribed";
}

export async function unsubscribeNativePush(): Promise<void> {
  const remembered = rememberedToken();
  if (!remembered) return;
  await api.POST("/api/notifications/push/native/unsubscribe", { body: remembered });
  rememberToken(remembered.platform, null);
}
