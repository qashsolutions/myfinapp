/**
 * An account that closed because its plan ended (owner, October 20, 2026): the device keeps its
 * data until the person downloads it, erases it, or brings it into a new account. Remembered
 * under its own key (not `stackd.`), so clearing preferences for another account never loses it.
 * Only a hash of the email is kept, so the offer to bring data back is made to the same person.
 */
const KEY = "qash.kept_account";

export interface KeptAccount {
  user_id: string;
  closed_at: string;
  email_hash: string | null;
}

export async function emailHash(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function keptAccount(): KeptAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as KeptAccount) : null;
  } catch {
    return null;
  }
}

export function rememberKept(kept: KeptAccount): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // storage blocked: the data is still in the database; nothing more to do
  }
}

export function forgetKept(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}

const CURRENT = "qash.account_hash";

/** While signed in: this account's id and email hash, so a later close can be matched to it. */
export async function rememberCurrent(userId: string, email: string): Promise<void> {
  try {
    const hash = await emailHash(email);
    localStorage.setItem(CURRENT, JSON.stringify({ user_id: userId, hash }));
  } catch {
    // storage or crypto unavailable: a later offer to bring data back just won't be made
  }
}

export function currentHashFor(userId: string): string | null {
  try {
    const raw = localStorage.getItem(CURRENT);
    const v = raw ? (JSON.parse(raw) as { user_id?: string; hash?: string }) : null;
    return v?.user_id === userId && typeof v.hash === "string" ? v.hash : null;
  } catch {
    return null;
  }
}
