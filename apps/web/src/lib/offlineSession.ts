/**
 * Opening the app with no network (hard constraint 4: offline for viewing and logging; October
 * 29, 2026, invariant 36). The server is the authority on the session, but with no network it
 * can't answer, and the person's money lives on this device anyway. So the device remembers who
 * was last signed in here, and which of their passkeys unlocked it here, and an offline open
 * shows the lock screen for that person:
 *
 * - Offline, the app is always locked first, whatever it was before: it can't ask the server.
 * - Unlocking offline is a passkey check on this device only (user verification required,
 *   limited to the passkeys that unlocked this account here). It opens what is on this device
 *   and nothing on the server: the server session stays as it was (locked after the idle
 *   time), so export, deletion, plans, linking and backups still need the real passkey check
 *   once the network is back. Someone able to change the app's code on this device could read
 *   its storage directly, so a server round trip would protect nothing more here.
 * - Signing out, or the server saying there is no session, forgets all of it; deleting the
 *   account erases every `stackd.` key with it.
 *
 * Kept in `localStorage` (it must survive a reload, which is when it is needed): the session
 * answer as the server last gave it, the passkey ids and the relying party id. No secret: a
 * passkey id names a credential, it can't sign anything.
 */

import type { SessionInfo } from "../data/api.ts";

const KEY = "stackd.offline_session";
/** Log out pressed with no network: the server is told on the next open with a network. */
export const SIGN_OUT_PENDING_KEY = "stackd.sign_out_pending";
/** At most this many passkey ids are remembered (newest first). */
const MAX_CREDENTIALS = 5;

interface Stored {
  info: SessionInfo;
  rp_id: string | null;
  credential_ids: string[];
}

interface Noted {
  rpId: string | null;
  id: string;
}

/** A passkey that just passed a sign-in on the server, for the account the next answer names. */
let pending: Noted | null = null;

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (!parsed.info?.user?.id || !Array.isArray(parsed.credential_ids)) return null;
    return {
      info: parsed.info,
      rp_id: typeof parsed.rp_id === "string" ? parsed.rp_id : null,
      credential_ids: parsed.credential_ids.filter((c): c is string => typeof c === "string"),
    };
  } catch {
    return null;
  }
}

function write(stored: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // storage blocked: an offline open shows Welcome, as before
  }
}

function withCredential(stored: Stored, noted: Noted): Stored {
  const ids = [noted.id, ...stored.credential_ids.filter((c) => c !== noted.id)];
  return {
    ...stored,
    rp_id: noted.rpId ?? stored.rp_id,
    credential_ids: ids.slice(0, MAX_CREDENTIALS),
  };
}

/**
 * The server's answer for a signed-in account with a passkey. Another account than the one
 * remembered replaces it, passkeys and all, so one account's passkey never opens another's.
 */
export function rememberSession(info: SessionInfo): void {
  const userId = info.user?.id;
  if (!info.authenticated || !info.has_passkeys || !userId) return;
  const stored = read();
  let next: Stored =
    stored && stored.info.user?.id === userId
      ? { ...stored, info }
      : { info, rp_id: null, credential_ids: [] };
  if (pending) next = withCredential(next, pending);
  pending = null;
  write(next);
}

/**
 * A passkey the server just accepted. `signedIn` is true when the account was already known
 * (unlock, step-up, adding a passkey); a sign-in waits for the next session answer to say whose.
 */
export function noteCredential(rpId: string | null, id: string, signedIn: boolean): void {
  const noted = { rpId, id };
  const stored = read();
  if (signedIn && stored) write(withCredential(stored, noted));
  else pending = noted;
}

/** The last answer, locked: what the app shows when the server can't be reached. */
export function offlineSession(): SessionInfo | null {
  const stored = read();
  return stored ? { ...stored.info, locked: true } : null;
}

/** What an offline unlock may use: this account's passkeys that unlocked it on this device. */
export function offlineUnlock(): { rpId: string | null; credentialIds: string[] } | null {
  const stored = read();
  if (!stored || stored.credential_ids.length === 0) return null;
  return { rpId: stored.rp_id, credentialIds: stored.credential_ids };
}

export function forgetSession(): void {
  pending = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

export function markSignOutPending(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGN_OUT_PENDING_KEY, "1");
    else localStorage.removeItem(SIGN_OUT_PENDING_KEY);
  } catch {
    // storage unavailable
  }
}

export function signOutPending(): boolean {
  try {
    return localStorage.getItem(SIGN_OUT_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}
