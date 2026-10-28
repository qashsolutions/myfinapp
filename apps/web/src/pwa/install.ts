/**
 * Install prompt logic (docs/spec.md "PWA-only screens and states"): never inside the installed
 * app; offered after the second visit or from Settings; "Not now" hides it for 14 days
 * (owner sign-off, October 27, 2026). iPhone gets the Share → Add to Home Screen steps;
 * everything else uses the browser's own install dialog when it offers one
 * (`beforeinstallprompt`).
 */

import { isStandalone } from "../lib/platform.ts";

export const VISITS_KEY = "stackd.visits";
export const DISMISSED_KEY = "stackd.install_dismissed";
export const DISMISS_DAYS = 14; // owner sign-off, October 27, 2026

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Call once at start-up: keeps the browser's install event for when the user taps Install. */
export function watchInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The browser offered its own dialog (Android Chrome, desktop Chrome and Edge). */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const event = deferred;
  deferred = null;
  notify();
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome;
}

export type InstallPlatform = "iphone" | "other";

export function installPlatform(userAgent = navigator.userAgent): InstallPlatform {
  return /iPhone|iPad|iPod/.test(userAgent) ? "iphone" : "other";
}

/**
 * Which install path fits this browser (the /install page, October 19, 2026). Only Safari can
 * add a web app to an iPhone's Home Screen reliably, so other iPhone browsers and in-app
 * browsers (Instagram, Facebook, Gmail…) are asked to open the page in Safari.
 */
export type InstallTarget = "iphone_safari" | "iphone_other" | "android" | "desktop";

export function installTarget(userAgent = navigator.userAgent): InstallTarget {
  if (/iPhone|iPad|iPod/.test(userAgent))
    return /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line\/|GSA\/|Snapchat|LinkedInApp/.test(
      userAgent,
    )
      ? "iphone_other"
      : "iphone_safari";
  return /Android/.test(userAgent) ? "android" : "desktop";
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the guide just offers itself again next time
  }
}

/** Counts a visit (one per page load) and returns the total. */
export function recordVisit(): number {
  const visits = Number(read(VISITS_KEY) ?? "0") + 1;
  write(VISITS_KEY, String(visits));
  return visits;
}

export function dismissInstall(now: Date = new Date()): void {
  write(DISMISSED_KEY, now.toISOString());
}

/** Whether to offer the guide on its own (Settings can always open it). */
export function shouldOfferInstall(now: Date = new Date()): boolean {
  if (isStandalone()) return false;
  if (Number(read(VISITS_KEY) ?? "0") < 2) return false;
  const dismissed = read(DISMISSED_KEY);
  if (dismissed) {
    const since = now.getTime() - new Date(dismissed).getTime();
    if (since < DISMISS_DAYS * 24 * 60 * 60 * 1000) return false;
  }
  return installPlatform() === "iphone" || canPromptInstall();
}
