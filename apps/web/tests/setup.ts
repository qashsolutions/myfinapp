import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

// The passkey ceremony needs a real authenticator; tests get a cooperative stand-in and the
// server side is faked in tests/fakeApi.ts. Cancellation is simulated by rejecting with
// a NotAllowedError-shaped error.
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  // The email box's passkey suggestion is off unless a test turns it on.
  browserSupportsWebAuthnAutofill: vi.fn(async () => false),
  WebAuthnAbortService: { cancelCeremony: vi.fn(), createNewAbortSignal: vi.fn() },
  startRegistration: vi.fn(async () => ({
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: {},
  })),
  startAuthentication: vi.fn(async () => ({
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: {},
  })),
}));

// jsdom has no matchMedia. A controllable stand-in so "Match system" can be tested.
type Listener = (e: MediaQueryListEvent) => void;
const listeners = new Set<Listener>();
let systemDark = false;
let viewportWidth = 390; // a phone unless a test says otherwise

export function setSystemDark(dark: boolean): void {
  systemDark = dark;
  for (const l of listeners) l({ matches: dark } as MediaQueryListEvent);
}

/** Pretend the viewport is 900px or wider (side rail) or a phone (tab bar). */
export function setWideViewport(isWide: boolean): void {
  viewportWidth = isWide ? 1000 : 390;
}

/** Any width: 900 and up is the desktop two-pane layout. */
export function setViewportWidth(px: number): void {
  viewportWidth = px;
}

// A file marked `@vitest-environment node` (the PDF reader) has no window to decorate.
if (typeof window !== "undefined")
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      media: query,
      get matches() {
        if (query.includes("dark")) return systemDark;
        if (query.includes("min-width")) {
          const px = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
          return viewportWidth >= px;
        }
        return false;
      },
      onchange: null,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
      dispatchEvent: () => true,
    }) as MediaQueryList;

if (typeof window !== "undefined") window.scrollTo = () => {}; // jsdom logs "not implemented" otherwise

beforeEach(async () => {
  if (typeof window === "undefined") return;
  localStorage.clear();
  sessionStorage.clear();
  const { closeDb, deleteDb } = await import("../src/data/db.ts");
  // A short test can end with the shell's live queries still in flight; let them finish
  // before the database they read goes, or Dexie reports a closed-database rejection.
  await new Promise((resolve) => setTimeout(resolve, 25));
  closeDb("u1");
  await deleteDb("u1");
  const { resetEntitlements } = await import("../src/features/billing/entitlements.ts");
  resetEntitlements();
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#F4F5F8";
  document.head.append(meta);
  systemDark = false;
  viewportWidth = 390;
  listeners.clear();
  for (const a of ["data-mode", "data-simple"]) document.documentElement.removeAttribute(a);
});
