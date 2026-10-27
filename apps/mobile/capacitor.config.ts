import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The native shells (docs/spec.md Phase 2, chunk 2.1) wrap the same apps/web build: nothing in
 * apps/web assumes them (hard constraint 4; `lib/platform.ts` is the one place that notices
 * Capacitor). `pnpm -C apps/web build`, then `pnpm -C apps/mobile sync` copies dist/ into both
 * projects; see README.md for running on devices.
 *
 * Origins. On Android the WebView's origin is https://<APP_HOST>: the same origin as the API
 * and the passkey relying party, so the session cookie, the CSRF guard and WebAuthn behave as
 * in the PWA once the site publishes Digital Asset Links for the app. iOS cannot use https for
 * local content (WKWebView owns that scheme), so its origin is capacitor://<APP_HOST>; the native
 * HTTP and cookie plugins carry the session there, `data/api.ts` calls the API at
 * https://<APP_HOST>, and passkeys inside the shell are chunk 2.3.
 */

// [domain] placeholder: the app's host, which must equal STACKD_RP_ID in production.
const APP_HOST = process.env.STACKD_APP_HOST ?? "app.stackd.test";

const config: CapacitorConfig = {
  // Placeholder until [Company legal name] and [domain] are decided; changing it later means
  // new store listings, so decide before 2.5.
  appId: process.env.STACKD_APP_ID ?? "com.stackd.app",
  appName: "Stackd",
  webDir: "../web/dist",
  server: {
    hostname: APP_HOST,
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
    scrollEnabled: true,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Requests go through the platform's HTTP stack with its own cookie jar, so the HttpOnly
    // session cookie works from the capacitor:// origin on iOS too.
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
  },
};

export default config;
