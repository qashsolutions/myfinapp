/**
 * Who last signed in on this device, so Welcome can say "Welcome back" and offer one-tap
 * passkey sign-in (October 13, 2026). Only a masked address is kept ("ma•••@gmail.com"), never
 * the full email; signing out keeps it, deleting the account clears every `stackd.` key.
 */

export const LAST_ACCOUNT_KEY = "stackd.last_account";

export interface LastAccount {
  masked: string;
  initial: string;
  name: string | null;
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}•••${email.slice(at)}`;
}

export function rememberAccount(email: string, name: string | null): void {
  const value: LastAccount = {
    masked: maskEmail(email),
    initial: (name?.trim() || email).charAt(0).toUpperCase(),
    name: name?.trim().split(/\s+/)[0] || null,
  };
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(value));
  } catch {
    // storage unavailable: Welcome shows the first-visit version
  }
}

export function lastAccount(): LastAccount | null {
  try {
    const raw = localStorage.getItem(LAST_ACCOUNT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastAccount>;
    return typeof v.masked === "string" && typeof v.initial === "string"
      ? { masked: v.masked, initial: v.initial, name: v.name ?? null }
      : null;
  } catch {
    return null;
  }
}

export function forgetAccount(): void {
  try {
    localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // nothing to forget
  }
}
