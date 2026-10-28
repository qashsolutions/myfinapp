/**
 * The session store: who is signed in and what the app may show.
 *
 *   loading        first call to GET /api/auth/session in flight
 *   signed_out     no session: Welcome / sign-in
 *   needs_passkey  email code done, passkey not yet created (sign-up in progress)
 *   locked         a passkey check is needed (new device, or 5 idle minutes)
 *   ready          unlocked
 *
 * The server is the authority (`locked` from the API); the client also locks itself on
 * inactivity (SessionLock) and on a `locked` signal from any response.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, backgroundApi, onAuthSignal, type SessionInfo } from "../../data/api.ts";
import { closeDb, deleteDb } from "../../data/db.ts";
import { currentHashFor, rememberCurrent, rememberKept } from "../../lib/keptAccount.ts";
import { rememberAccount } from "../../lib/lastAccount.ts";

/** Erase this device's copy of a deleted account: its database and every `stackd.` key. */
async function wipeDevice(userId: string): Promise<void> {
  try {
    closeDb(userId);
    await deleteDb(userId);
  } catch {
    // nothing stored here, or storage blocked: nothing to erase
  }
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("stackd.")) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
  if (typeof window !== "undefined" && window.location.pathname !== "/deleted")
    window.location.replace("/deleted");
}

/** Keep this device's copy of an account whose plan ended, and show where it is. */
async function keepDevice(userId: string): Promise<void> {
  rememberKept({
    user_id: userId,
    closed_at: new Date().toISOString(),
    email_hash: currentHashFor(userId),
  });
  if (typeof window !== "undefined" && window.location.pathname !== "/kept")
    window.location.replace("/kept");
}

export type SessionStatus = "loading" | "signed_out" | "needs_passkey" | "locked" | "ready";

export interface Session {
  status: SessionStatus;
  info: SessionInfo | null;
  /** Re-read the session from the server. */
  refresh: () => Promise<SessionInfo | null>;
  /** Lock (inactivity): the screen and the server session; the next unlock asserts the passkey. */
  lock: () => void;
  /** After a successful passkey check on this device. */
  unlocked: (passkeyVerifiedAt: string) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function statusOf(info: SessionInfo | null, clientLocked: boolean): SessionStatus {
  if (!info?.authenticated) return "signed_out";
  if (!info.has_passkeys) return "needs_passkey";
  if (info.locked || clientLocked) return "locked";
  return "ready";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clientLocked, setClientLocked] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const { data } = await api.GET("/api/auth/session");
    if (!alive.current) return null;
    const next = data ?? null;
    // This device's account was deleted elsewhere (another device, the website, or a plan that
    // ended): erase what this device kept, then say so (October 14, 2026).
    if (next && !next.authenticated && next.deleted_user_id) {
      // A plan that ended closes the account but never takes the device's data (owner, October
      // 20, 2026): it stays until the person decides. A deletion they asked for erases it.
      if (next.deleted_reason === "plan_ended") await keepDevice(next.deleted_user_id);
      else await wipeDevice(next.deleted_user_id);
    }
    // Remember who uses this device (masked), so Welcome can offer one-tap passkey sign-in.
    if (next?.authenticated && next.has_passkeys && next.user) {
      rememberAccount(next.user.email, next.user.display_name ?? null);
      void rememberCurrent(next.user.id, next.user.email);
    }
    setInfo(next);
    setLoaded(true);
    if (next?.locked === false) setClientLocked(false);
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  useEffect(
    () =>
      onAuthSignal((signal) => {
        if (signal === "sign_in_required") setInfo((i) => (i ? { ...i, authenticated: false } : i));
        if (signal === "locked") setClientLocked(true);
      }),
    [],
  );

  // The screen locks at once; the server is told to lock this session too, so it stays locked
  // there until the next passkey check (owner decision, October 28, 2026). Offline, the
  // server's own idle clock still locks it.
  const lockSent = useRef(false);
  const lock = useCallback(() => {
    setClientLocked(true);
    if (lockSent.current) return; // once per lock, however many checks fire before the repaint
    lockSent.current = true;
    void backgroundApi.POST("/api/auth/lock").catch(() => null);
  }, []);
  useEffect(() => {
    if (!clientLocked) lockSent.current = false; // unlocked: the next lock tells the server again
  }, [clientLocked]);
  const unlocked = useCallback((passkeyVerifiedAt: string) => {
    setClientLocked(false);
    setInfo((i) =>
      i ? { ...i, locked: false, has_passkeys: true, passkey_verified_at: passkeyVerifiedAt } : i,
    );
  }, []);
  const signOut = useCallback(async () => {
    await api.POST("/api/auth/signout");
    setClientLocked(false);
    setInfo((i) => (i ? { ...i, authenticated: false } : i));
  }, []);

  const value = useMemo<Session>(
    () => ({
      status: loaded ? statusOf(info, clientLocked) : "loading",
      info,
      refresh,
      lock,
      unlocked,
      signOut,
    }),
    [loaded, info, clientLocked, refresh, lock, unlocked, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
