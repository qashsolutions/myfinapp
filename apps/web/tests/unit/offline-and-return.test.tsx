/**
 * The defect round of October 29, 2026 (owner audit items 2, 3 and 7):
 *
 * - invariant 35: a network failure is an answer, so nothing waits on it for good;
 * - invariant 36: the app opens with no network, locked, and unlocks on this device only;
 * - invariant 37: signing in ends where the link that started it pointed.
 */
import { startAuthentication } from "@simplewebauthn/browser";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authEvents } from "../../src/data/api.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { safeReturn } from "../../src/lib/returnTo.ts";
import {
  emptyHouseholds,
  installFakeApi,
  mayasGroup,
  readySession,
  signedOut,
  VALID_CODE,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function setOnline(on: boolean) {
  Object.defineProperty(navigator, "onLine", { value: on, configurable: true });
}

/** authenticatorData with the flags byte saying user present + user verified. */
function verifiedAuthData(uv = true): string {
  const bytes = new Uint8Array(37);
  bytes[32] = uv ? 0x05 : 0x01;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign in online once with a passkey check, so this device remembers the account. */
async function unlockOnceOnline() {
  const user = userEvent.setup();
  const api = installFakeApi({ session: readySession({ locked: true }) });
  const view = renderApp("/budget");
  await user.click(await screen.findByRole("button", { name: /^Unlock with/ }));
  await screen.findByRole("navigation", { name: "Primary" });
  view.unmount();
  return api;
}

afterEach(() => {
  setOnline(true);
  sessionStorage.clear();
});

describe("invariant 35: a network failure is an answer", () => {
  it("Start trial with the network dropped says You're offline and lets the person try again", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free" };
    renderApp("/start");
    const start = await screen.findByRole("button", { name: /^Start my/ });
    api.offline = true;
    await user.click(start);
    expect(await screen.findByText("You're offline. Try again when connected.")).toBeVisible();
    expect(start).toBeEnabled();
  });
});

describe("invariant 36: opening the app with no network", () => {
  it("shows the lock screen, not a blank page, and unlocks on this device only", async () => {
    const api = await unlockOnceOnline();
    const user = userEvent.setup();
    api.offline = true;
    setOnline(false);
    renderApp("/budget");
    expect(await screen.findByText(/You're offline\. Unlock to use what's on this device/)).toBe(
      screen.getByText(/You're offline\. Unlock/),
    );
    const before = vi.mocked(startAuthentication).mock.calls.length;
    vi.mocked(startAuthentication).mockResolvedValueOnce({
      id: "cred-1",
      rawId: "cred-1",
      type: "public-key",
      response: { authenticatorData: verifiedAuthData() },
    } as never);
    await user.click(screen.getByRole("button", { name: /^Unlock with/ }));
    // Asked of the device alone: user verification, only this account's remembered passkey
    const options = vi.mocked(startAuthentication).mock.calls[before]?.[0]?.optionsJSON as {
      allowCredentials: { id: string }[];
      userVerification: string;
    };
    expect(options.allowCredentials.map((c) => c.id)).toEqual(["cred-1"]);
    expect(options.userVerification).toBe("required");
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("You're offline")).toBeInTheDocument();

    // Back online: the session is asked again (and the server's answer wins)
    const asked = api.calls.length;
    api.offline = false;
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(api.calls.slice(asked).some((c) => c.path === "/api/auth/session")).toBe(true),
    );
  });

  it("locked while the network is gone mid-run, Unlock checks the passkey on this device", async () => {
    const api = await unlockOnceOnline();
    const user = userEvent.setup();
    renderApp("/budget");
    await screen.findByRole("navigation", { name: "Primary" });
    api.offline = true;
    act(() => {
      authEvents.dispatchEvent(new CustomEvent("auth", { detail: "locked" }));
    });
    vi.mocked(startAuthentication).mockResolvedValueOnce({
      id: "cred-1",
      rawId: "cred-1",
      type: "public-key",
      response: { authenticatorData: verifiedAuthData() },
    } as never);
    await user.click(await screen.findByRole("button", { name: /^Unlock with/ }));
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("refuses a passkey that is not this account's, or one that skipped verification", async () => {
    const api = await unlockOnceOnline();
    const user = userEvent.setup();
    api.offline = true;
    renderApp("/budget");
    vi.mocked(startAuthentication).mockResolvedValueOnce({
      id: "someone-else",
      rawId: "someone-else",
      type: "public-key",
      response: { authenticatorData: verifiedAuthData() },
    } as never);
    await user.click(await screen.findByRole("button", { name: /^Unlock with/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    vi.mocked(startAuthentication).mockResolvedValueOnce({
      id: "cred-1",
      rawId: "cred-1",
      type: "public-key",
      response: { authenticatorData: verifiedAuthData(false) },
    } as never);
    await user.click(screen.getByRole("button", { name: /^Unlock with/ }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("says to connect once when this device never unlocked the account", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const view = renderApp("/budget");
    await screen.findByRole("navigation", { name: "Primary" });
    view.unmount();
    api.offline = true;
    renderApp("/budget");
    await user.click(await screen.findByRole("button", { name: /^Unlock with/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You're offline. Connect once to unlock here, then it works offline too.",
    );
  });

  it("signed out with nothing kept, an offline open shows Welcome", async () => {
    const api = installFakeApi({ session: signedOut() });
    api.offline = true;
    renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "Keep more of what you earn." }),
    ).toBeInTheDocument();
  });

  it("Log out with no network forgets here at once and tells the server on the next open", async () => {
    const api = await unlockOnceOnline();
    const user = userEvent.setup();
    let view = renderApp("/me");
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    api.offline = false;
    view.unmount();
    // The first sign-out went through: nothing pending. Now one with no network:
    api.session = readySession();
    view = renderApp("/me");
    await screen.findByRole("button", { name: "Log out" });
    api.offline = true;
    await user.click(screen.getByRole("button", { name: "Log out" }));
    view.unmount();
    view = renderApp("/");
    // nothing kept to open offline: Welcome (back), never the lock screen
    expect(await screen.findByRole("heading", { name: /^Welcome back/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unlock with/ })).toBeNull();
    view.unmount();
    api.offline = false;
    const asked = api.calls.length;
    view = renderApp("/");
    await waitFor(() =>
      expect(api.calls.slice(asked).map((c) => c.path)).toEqual(
        expect.arrayContaining(["/api/auth/signout", "/api/auth/session"]),
      ),
    );
    expect(api.calls.slice(asked).findIndex((c) => c.path === "/api/auth/signout")).toBeLessThan(
      api.calls.slice(asked).findIndex((c) => c.path === "/api/auth/session"),
    );
  });
});

describe("invariant 37: signing in returns where the link pointed", () => {
  it("only ever returns to a screen of this app", () => {
    expect(safeReturn("/groups/join?code=STK-4F9Q")).toBe("/groups/join?code=STK-4F9Q");
    expect(safeReturn("/household/join?code=HH-1#k=abc")).toBe("/household/join?code=HH-1#k=abc");
    for (const bad of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "/welcome",
      "/signin/code",
      "/signup/passkey",
      "/start",
      "/",
      "",
      null,
    ])
      expect(safeReturn(bad), String(bad)).toBeNull();
  });

  it("a challenge link opened signed out: sign up, passkey, trial pick, then the challenge", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: signedOut(), groups: [mayasGroup()] });
    api.access = { state: "choose", plan: "free" };
    renderApp("/groups/join?code=stk-4f9q");
    await user.click(await screen.findByRole("link", { name: "Get started" }));
    await user.type(screen.getByLabelText("Email address"), "nia@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.click(await screen.findByLabelText("6-digit code"));
    await user.paste(VALID_CODE);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Create passkey" }));
    await user.click(await screen.findByRole("button", { name: "Continue to setup" }));
    await user.click(await screen.findByRole("button", { name: /^Start my/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join a group" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Invite code")).toHaveValue("STK-4F9Q");
  });

  it("a household invite opened signed out keeps its #k= key on the device and lands on it", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const KEY = "HouseholdKeyNeverSentAnywhere0123456789abcdef";
    const api = installFakeApi({
      session: signedOut(),
      accountHasPasskeys: true,
      households: emptyHouseholds(),
    });
    renderApp(`/household/join?code=HH-ABC123#k=${KEY}`);
    await user.click(await screen.findByRole("link", { name: "Get started" }));
    await user.type(screen.getByLabelText("Email address"), "dev@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.click(await screen.findByLabelText("6-digit code"));
    await user.paste(VALID_CODE);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // A returning account: the lock screen asks for the passkey, then the invite
    await user.click(await screen.findByRole("button", { name: /^Unlock with/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join a household" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/This link is missing its key/)).toBeNull();
    // The key never reached the server: not in a URL, a header or a body
    for (const c of api.calls)
      expect(JSON.stringify([c.url, c.headers, c.raw]), c.path).not.toContain(KEY);
    expect(sessionStorage.getItem("stackd.return_to")).toBeNull(); // taken once
  });
});
