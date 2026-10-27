# @stackd/mobile

The iOS and Android shells (docs/spec.md Phase 2, chunk 2.1): Capacitor 8 around the same
`apps/web` build. Nothing in `apps/web` assumes a shell (`lib/platform.ts` is the one place that
notices Capacitor), so the PWA and the apps are one codebase.

| Path | What |
|---|---|
| `capacitor.config.ts` | `webDir: ../web/dist`; the app id and host (placeholders until `[domain]` and `[Company legal name]` are decided, overridable with `STACKD_APP_ID` / `STACKD_APP_HOST`); the native HTTP and cookie plugins that carry the session cookie. |
| `android/` | The generated Gradle project (`com.stackd.app`). Committed, as Capacitor intends; `cap sync` refreshes the copied web build and plugin wiring. |
| `ios/` | The generated Xcode project, dependencies through Swift Package Manager (no CocoaPods). |
| `scripts/assets.ts` | Renders the icons and launch screens for both projects from the PWA's mark (`pnpm assets`). |

## Build and run

```bash
pnpm -C apps/web build          # the web build both shells wrap
pnpm -C apps/mobile assets      # icons + launch screens (committed; CI checks they are current)
pnpm -C apps/mobile sync        # copies dist/ into android/ and ios/, updates plugin wiring
pnpm -C apps/mobile open:ios    # Xcode: pick a team, then run on a device or simulator
pnpm -C apps/mobile open:android   # Android Studio: run on a device or emulator
pnpm -C apps/mobile run:ios     # or straight to a connected device / simulator
pnpm -C apps/mobile run:android
```

Requirements on the machine that builds: Xcode 16 or newer with an Apple developer team (iOS),
Android Studio with SDK 35 and a Java 21 runtime (Android). Neither is installed on the
development Mac this was written on, so the "runs on test devices" step of chunk 2.1 is still
open; CI only assembles both projects from the web build (`.github/workflows/ci.yml`, job
`mobile`).

## How the shell reaches the API

- The web build is served from the app's host (`server.hostname`) on a local scheme. On Android
  that scheme is `https`, so the page's origin is the API's origin: the session cookie, the CSRF
  guard and WebAuthn passkeys behave as in the PWA once the website publishes Digital Asset Links
  (`/.well-known/assetlinks.json`) for the app's package and signing key.
- iOS cannot use `https` for local content, so the page's origin is `capacitor://<host>`. The
  `CapacitorHttp` and `CapacitorCookies` plugins send requests through the platform's HTTP stack
  with its own cookie jar, and `apps/web/src/data/api.ts` calls `https://<host>` whenever it runs
  inside a shell. Passkeys inside the iOS shell need the native authenticator: chunk 2.3.
- Production checklist: `STACKD_APP_HOST` = the app's domain = `STACKD_RP_ID`; the API's
  `STACKD_ORIGINS` already lists `https://<host>`, which is what Android sends.

## Native features (chunk 2.3)

The web side is done and tested (`apps/web/src/native/`: `camera.ts`, `push.ts`,
`biometrics.ts`, `widget.ts`, all reading the shell's plugins through
`lib/platform.nativePlugin`; `apps/web/tests/unit/native-features.test.tsx`). The shells carry
`@capacitor/camera` and `@capacitor/push-notifications`; receipts and push registration work as
soon as the projects run. What still needs Xcode / Android Studio:

- **Push credentials.** iOS: the Push Notifications capability on the App target, and in
  production the APNs .p8 key as `STACKD_APNS_KEY` / `KEY_ID` / `TEAM_ID` (the server sends
  through `services/push_native.py`; sandbox by default). Android: a Firebase project's
  `google-services.json` in `android/app/` and the service-account JSON as
  `STACKD_FCM_SERVICE_ACCOUNT`.
- **`StackdPasskeys` plugin** (Face ID / fingerprint sign-in): WKWebView cannot run WebAuthn
  from the capacitor:// origin, so a small plugin bridges to ASAuthorization (iOS) and
  Credential Manager (Android). Contract (see `apps/web/src/native/biometrics.ts`): methods
  `create` and `get`, each taking `{ optionsJSON }` (the server's publicKey options, JSON) and
  resolving `{ credentialJSON }` shaped exactly like @simplewebauthn/browser's output; reject
  with `{ "name": "NotAllowedError" }` on cancel. Associated domains: `webcredentials:<host>`
  (iOS) and the site's assetlinks.json (Android), with the host equal to `STACKD_RP_ID`.
  Without the plugin the web ceremony is tried, which newer Android WebViews support.
- **`StackdWidget` plugin + the widget targets**: method `setSummary` taking
  `{ month, got, spent, kept }` (display strings Home already shows), written to the App Group
  (iOS) / shared preferences (Android) and reloading the widget timeline. The widget renders
  those strings only; nothing leaves the device.

- **`StackdPurchases` plugin** (chunk 2.4, StoreKit 2 / Play Billing): `purchase({ productId,
  accountToken })` runs the payment sheet with the user id attached (`appAccountToken` on iOS,
  `obfuscatedExternalAccountId` on Android) and resolves the store's proof — `{ jws }` (the
  transaction's `jwsRepresentation`) on iOS, `{ purchaseToken }` on Android — rejecting with
  `{ "name": "NotAllowedError" }` when the sheet is closed; `restore({ accountToken })` resolves
  `{ purchases: [proof] }` for everything the store still vouches for; `manageSubscriptions()`
  opens the OS subscription page. The server verifies every proof itself
  (`services/native_billing.py`), so the plugin never talks to our API. Products to create in
  both consoles, with these exact ids (plans.yaml `store_products`):
  `com.stackd.app.private.monthly`, `com.stackd.app.private.yearly`,
  `com.stackd.app.connected.monthly`, `com.stackd.app.connected.yearly`. App Store Server
  Notifications V2 point at `/api/webhooks/apple`; Play RTDN's Pub/Sub push at
  `/api/webhooks/google`.

## Store assets

`store/` holds the listing texts, Apple privacy labels and Play Data safety answers (chunk 2.5; drafts until `[owner]` signs) with the remaining human steps in `store/README.md`. `scripts/assets.ts` writes the iOS app icon (1024) and splash set, and Android's launcher icons
(legacy, round and the adaptive foreground; the adaptive background colour is
`values/ic_launcher_background.xml`) and splash drawables. Listings, screenshots, privacy labels
and the Data safety form are chunk 2.5 (`store/`).
