/**
 * Where someone was going before signing in (invariant 37, October 29, 2026). A challenge link
 * (`/groups/join?code=…`) or a household invite (`/household/join?code=…#k=…`) opened while
 * signed out leads through Welcome, the email code or a passkey, passkey setup and the trial
 * pick; afterwards the person lands where the link pointed, not on Home.
 *
 * - Only a path in this app: it must start with one "/", resolve to this page's own origin and
 *   not be one of the sign-in screens, so a crafted link can never send anyone elsewhere.
 * - Kept in `sessionStorage` (this tab only, gone when it closes) with its query and fragment.
 *   The household key in `#k=` stays on the device: it is never put in a query string or sent
 *   in any request, exactly as when the link is opened signed in.
 * - Taken once (`AccessGate` takes it once the plan state lets the app open), and forgotten on
 *   sign-out.
 */

const KEY = "stackd.return_to";

/** Screens of the way in: never a place to come back to. */
const WAY_IN = ["/welcome", "/signin", "/signup", "/start", "/deleted", "/kept", "/link"];

/** The path, query and fragment when they name a screen of this app; else null. */
export function safeReturn(target: string | null | undefined): string | null {
  if (!target?.startsWith("/") || target.startsWith("//") || target.includes("\\")) return null;
  let url: URL;
  try {
    const origin = globalThis.location?.origin ?? "http://localhost";
    url = new URL(target, origin);
    if (url.origin !== origin) return null;
  } catch {
    return null;
  }
  const path = url.pathname;
  if (path === "/") return null;
  if (WAY_IN.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  return `${path}${url.search}${url.hash}`;
}

export function rememberReturn(target: string): void {
  const safe = safeReturn(target);
  if (!safe) return;
  try {
    sessionStorage.setItem(KEY, safe);
  } catch {
    // storage blocked: the person lands on Home, as before
  }
}

export function pendingReturn(): string | null {
  try {
    return safeReturn(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** The remembered place, once: reading it forgets it. */
export function takeReturn(): string | null {
  const target = pendingReturn();
  forgetReturn();
  return target;
}

export function forgetReturn(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}
