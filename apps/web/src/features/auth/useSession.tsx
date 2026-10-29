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
 *
 * No network (invariant 36, October 29, 2026): when the session check can't reach the server,
 * the last answer this device kept for a signed-in account is used, always locked, and the
 * lock screen unlocks it with a passkey check on this device only (lib/offlineSession.ts says
 * why). The check runs again as soon as the device is back online.
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
import {
  currentHashFor,
  keptAccount,
  rememberCurrent,
  rememberKept,
} from "../../lib/keptAccount.ts";
import { forgetAccount, rememberAccount } from "../../lib/lastAccount.ts";
import {
  forgetSession,
  markSignOutPending,
  offlineSession,
  rememberSession,
  signOutPending,
} from "../../lib/offlineSession.ts";
import { forgetReturn } from "../../lib/returnTo.ts";

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
  forgetSession();
  // The account is closed: Welcome must not offer its passkey again (invariant 57). The kept
  // record says who it was; a second report of the same closure keeps the first date.
  forgetAccount();
  const known = keptAccount();
  rememberKept({
    user_id: userId,
    closed_at:
      known?.user_id === userId && known.closed_at ? known.closed_at : new Date().toISOString(),
    email_hash: currentHashFor(userId) ?? (known?.user_id === userId ? known.email_hash : null),
  });
  if (typeof window !== "undefined" && window.location.pathname !== "/kept")
    window.location.replace("/kept");
}

export type SessionStatus = "loading" | "signed_out" | "needs_passkey" | "locked" | "ready";

export interface Session {
  status: SessionStatus;
  info: SessionInfo | null;
  /** The last session check couldn't reach the server: `info` is this device's last answer. */
  offline: boolean;
  /** Re-read the session from the server. */
  refresh: () => Promise<SessionInfo | null>;
  /** Lock (inactivity): the screen and the server session; the next unlock asserts the passkey. */
  lock: () => void;
  /** After a successful passkey check on this device. */
  unlocked: (passkeyVerifiedAt: string) => void;
  /** After a passkey check on this device with no network: opens this device's data only. */
  unlockedOffline: () => void;
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
  const [offline, setOffline] = useState(false);
  const offlineRef = useRef(false);
  const answered = useRef<SessionInfo | null | undefined>(undefined); // the server's last word
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    // Log out pressed with no network: tell the server first, so the cookie it still honours
    // never signs this device back in.
    if (signOutPending()) {
      const out = await api.POST("/api/auth/signout");
      if (out.response.status !== 0 && out.response.status < 500) markSignOutPending(false);
    }
    const r = await api.GET("/api/auth/session");
    if (!alive.current) return null;
    // The session check never answers an error, so no answer means no network or no server
    // (a proxy's 502 too): fall back to what this device kept, locked (invariant 36).
    if (!r.data) {
      offlineRef.current = true;
      setOffline(true);
      // The server already answered in this run (the network dropped later): what it said
      // stands, locked or not, and the idle lock keeps running.
      if (answered.current !== undefined) return answered.current;
      const kept = signOutPending() ? null : offlineSession();
      setInfo(kept);
      setLoaded(true);
      return kept;
    }
    offlineRef.current = false;
    setOffline(false);
    const next = r.data;
    answered.current = next;
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
      rememberSession(next);
    } else if (!next.authenticated) forgetSession(); // the server's word: no session here
    setInfo(next);
    setLoaded(true);
    if (next?.locked === false) setClientLocked(false);
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // Back online after an offline open: ask the server again (it may still say locked).
    const retry = () => {
      if (offlineRef.current) void refresh();
    };
    window.addEventListener("online", retry);
    return () => {
      alive.current = false;
      window.removeEventListener("online", retry);
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
  const unlockedOffline = useCallback(() => {
    // The server hasn't heard: ask it again once the device is back online.
    offlineRef.current = true;
    setOffline(true);
    setClientLocked(false);
    setInfo((i) => (i ? { ...i, locked: false } : i));
  }, []);
  const signOut = useCallback(async () => {
    const r = await api.POST("/api/auth/signout");
    // No network: this device forgets now and the server is told on the next open online.
    markSignOutPending(r.response.status === 0 || r.response.status >= 500);
    forgetSession();
    forgetReturn();
    answered.current = undefined;
    setClientLocked(false);
    setInfo((i) => (i ? { ...i, authenticated: false } : i));
  }, []);

  const value = useMemo<Session>(
    () => ({
      status: loaded ? statusOf(info, clientLocked) : "loading",
      info,
      offline,
      refresh,
      lock,
      unlocked,
      unlockedOffline,
      signOut,
    }),
    [loaded, info, offline, clientLocked, refresh, lock, unlocked, unlockedOffline, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
