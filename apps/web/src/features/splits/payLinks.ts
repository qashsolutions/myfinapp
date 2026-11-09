/**
 * Settling up through the person's own app (spec "Settling up"): Qash never holds or moves
 * money. A handle is saved only by its owner ("How friends pay me"); the link opens their app
 * with the amount filled in and nothing else (no group name, no note).
 */

import type { HandleApp } from "./ledger.ts";

export const HANDLE_APPS: ReadonlyArray<readonly [HandleApp, string]> = [
  ["venmo", "Venmo"],
  ["cashapp", "Cash App"],
  ["paypal", "PayPal"],
];

export const APP_NAME: Record<HandleApp, string> = {
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
};

/** The version of the Check first warning (services/api rules_server/splits.yaml). */
export const PAY_WARNING_VERSION = "2026-11-08";

/** A handle changed within this many days is shown with "Changed recently" (splits.yaml). */
export const CHANGED_RECENTLY_DAYS = 3;

const RULES: Record<HandleApp, { strip: RegExp; ok: RegExp; hint: string }> = {
  venmo: {
    strip: /^@/,
    ok: /^[A-Za-z0-9_-]{5,30}$/,
    hint: "A Venmo username is 5 to 30 letters, numbers, - or _.",
  },
  cashapp: {
    strip: /^\$/,
    ok: /^[A-Za-z][A-Za-z0-9_]{0,19}$/,
    hint: "A $cashtag starts with a letter, up to 20 characters.",
  },
  paypal: {
    strip: /^(https?:\/\/)?(www\.)?paypal\.me\//i,
    ok: /^[A-Za-z0-9]{1,20}$/,
    hint: "Your PayPal.Me name: up to 20 letters and numbers.",
  },
};

/** The handle as stored ("sam-l", "samlee", "SamLee"), "" when empty, or null when not valid. */
export function cleanHandle(app: HandleApp, typed: string): string | null {
  const t = typed.trim().replace(RULES[app].strip, "");
  if (t === "") return "";
  return RULES[app].ok.test(t) ? t : null;
}

export function handleHint(app: HandleApp): string {
  return RULES[app].hint;
}

/** How a handle reads on screen. */
export function showHandle(app: HandleApp, handle: string): string {
  return app === "venmo" ? `@${handle}` : app === "cashapp" ? `$${handle}` : `paypal.me/${handle}`;
}

/** The link that opens their app with the amount filled in. */
export function payLink(app: HandleApp, handle: string, cents: number): string {
  const amount = (cents / 100).toFixed(2);
  const h = encodeURIComponent(handle);
  if (app === "venmo") return `https://venmo.com/${h}?txn=pay&amount=${amount}`;
  if (app === "cashapp") return `https://cash.app/$${h}/${amount}`;
  return `https://paypal.me/${h}/${amount}USD`;
}
