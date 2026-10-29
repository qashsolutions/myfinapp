/**
 * Where the app is running. The PWA never assumes a native shell (hard constraint 4);
 * Capacitor (Phase 2) sets window.Capacitor and this is the only place that looks for it.
 */

interface CapacitorLike {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorLike | undefined {
  return (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
}

export function isNativePlatform(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** Which shell this is; null in a browser. */
export function nativePlatform(): "ios" | "android" | null {
  if (!isNativePlatform()) return null;
  const platform = capacitor()?.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

/**
 * A plugin the shell registered (chunk 2.3: Camera, PushNotifications, StackdPasskeys,
 * StackdWidget), or null in a browser or when the shell lacks it. The `@capacitor/*` JS
 * packages never enter apps/web; the shell's runtime puts plugins on `Capacitor.Plugins`.
 */
export function nativePlugin<T>(name: string): T | null {
  if (!isNativePlatform()) return null;
  return (capacitor()?.Plugins?.[name] as T | undefined) ?? null;
}

/** True inside the installed app (Home Screen / desktop window), false in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

function touchPoints(): number {
  return typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0);
}

/**
 * An iPhone, iPod or iPad. iPadOS Safari asks for desktop sites and reports itself as a Mac, so
 * a "Macintosh" with a touch screen (Macs report no touch points) and no native shell is an iPad
 * (October 29, 2026). The one place that decides it.
 */
export function isAppleMobile(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  points = touchPoints(),
): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && points > 1 && !isNativePlatform();
}

/** What the device will ask for when a passkey is used: wording only, the platform decides. */
export function biometricName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (isAppleMobile(ua)) return "Face ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Android/.test(ua)) return "your fingerprint or face";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "your passkey";
}
