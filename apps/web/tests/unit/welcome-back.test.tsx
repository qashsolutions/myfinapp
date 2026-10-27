import { startAuthentication } from "@simplewebauthn/browser";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOOTER_LEGAL, FOOTER_PRODUCT } from "../../../site/src/data/site.ts";
import { LAST_ACCOUNT_KEY, maskEmail, rememberAccount } from "../../src/lib/lastAccount.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

/** October 13, 2026: nobody who can be recognised is asked to sign up again. */
describe("Welcome recognises returning people", () => {
  const realUA = navigator.userAgent;
  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { value: realUA, configurable: true });
    localStorage.clear();
  });

  it("masks the remembered address and never keeps the full email", () => {
    expect(maskEmail("maya.r@example.com")).toBe("ma•••@example.com");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    rememberAccount("maya.r@example.com", "Maya Rao");
    const raw = localStorage.getItem(LAST_ACCOUNT_KEY) ?? "";
    expect(raw).not.toContain("maya.r@");
    expect(JSON.parse(raw)).toEqual({ masked: "ma•••@example.com", initial: "M", name: "Maya" });
  });

  it("a first visit signs in with a synced passkey in one tap, no email or code", async () => {
    const user = userEvent.setup();
    const api = installFakeApi();
    renderApp("/welcome");
    await user.click(await screen.findByRole("button", { name: /Sign in with your passkey/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /passkey/ })).toBeNull());
    expect(api.calls.map((c) => c.path)).toContain("/api/auth/passkey/verify");
    expect(api.calls.some((c) => c.path === "/api/auth/otp/send")).toBe(false);
    // Signed in and unlocked: the app's navigation is there.
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("someone who used this device sees Welcome back and continues with one tap", async () => {
    const user = userEvent.setup();
    rememberAccount("maya.r@example.com", "Maya Rao");
    installFakeApi();
    renderApp("/welcome");
    expect(await screen.findByRole("heading", { name: "Welcome back, Maya." })).toBeInTheDocument();
    expect(screen.getByText("ma•••@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue with your passkey/ }));
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("a passkey we don't know points to the email sign-in instead", async () => {
    const user = userEvent.setup();
    const api = installFakeApi();
    api.passkeySignInUnknown = true;
    renderApp("/welcome");
    await user.click(await screen.findByRole("button", { name: /Sign in with your passkey/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Continue with your email/);
  });

  it("no passkey on this device (or the prompt closed) gets a friendly way on, not silence", async () => {
    const user = userEvent.setup();
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      Object.assign(new Error("closed"), { name: "NotAllowedError" }),
    );
    installFakeApi();
    renderApp("/welcome");
    await user.click(await screen.findByRole("button", { name: /Sign in with your passkey/ }));
    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("No Qash passkey on this device yet? Continue with your email.");
    expect(within(note).getByRole("link", { name: "Use email" })).toHaveAttribute(
      "href",
      "/signin",
    );
  });

  it("on a computer without Touch ID, the phone-as-passkey guide is one tap away", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      configurable: true,
    });
    installFakeApi();
    renderApp("/welcome");
    expect(
      await screen.findByRole("button", { name: /Sign in with Windows Hello/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No Windows Hello on this computer?" }));
    const sheet = await screen.findByRole("dialog", { name: "Use your phone instead" });
    expect(within(sheet).getByText("Scan it with your phone's camera")).toBeInTheDocument();
    // The QR path needs Bluetooth; the sheet says where to allow it (October 19, 2026)
    expect(within(sheet).getByRole("note")).toHaveTextContent("Bluetooth on, on both");
    // The button opens the browser's passkey window, asked to go straight to the phone QR code.
    vi.mocked(startAuthentication).mockClear();
    await user.click(within(sheet).getByRole("button", { name: "Show the QR code" }));
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(startAuthentication).mock.calls[0]?.[0] as unknown as {
      optionsJSON: { hints?: string[] };
    };
    expect(arg.optionsJSON.hints).toEqual(["hybrid"]);
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("phones don't get the computer guide", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
      configurable: true,
    });
    installFakeApi();
    renderApp("/welcome");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /on this computer\?/ })).toBeNull();
  });

  it("in an iPhone browser tab, installing comes first", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      configurable: true,
    });
    installFakeApi();
    renderApp("/welcome");
    expect(await screen.findByText("Install Qash first")).toBeInTheDocument();
    expect(screen.getByText(/the Home Screen app keeps its own data/)).toBeInTheDocument();
  });

  it("the signed-out pages carry the website's footer, row for row", async () => {
    installFakeApi();
    renderApp("/welcome");
    const nav = await screen.findByRole("navigation", { name: "About Qash" });
    const links = within(nav)
      .getAllByRole("link")
      .map((a) => [a.textContent, a.getAttribute("href")]);
    // One footer across the site and the app (owner, October 13, 2026).
    expect(links).toEqual(
      [...FOOTER_PRODUCT, ...FOOTER_LEGAL].map((l) => [l.label, `https://qash.solutions${l.href}`]),
    );
    expect(screen.getByText("© 2026 Qash Solutions Inc.")).toBeInTheDocument();
  });
});

describe("a new device with a backup", () => {
  it("Home offers to restore, and Not now remembers", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.backup.key = { key_version: 1, recovery_wrapped: "x", recovery_salt: "y" };
    api.backup.blobs.push({
      id: "b1",
      ciphertext: "AAAA",
      key_version: 1,
      snapshot_at: "2026-10-13T00:00:00Z",
      created_at: "2026-10-13T00:00:00Z",
      device_label: "iPhone",
    });
    renderApp("/");
    expect(await screen.findByText("Your backup is ready for this device")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByText("Your backup is ready for this device")).toBeNull(),
    );
  });

  it("nothing is offered when the account has no backup", async () => {
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your backup is ready for this device")).toBeNull();
  });
});

describe("Bluetooth hint", () => {
  it("names the Mac and Windows settings to allow", async () => {
    const { BluetoothHint } = await import("../../src/features/auth/NoBiometricsHelp.tsx");
    const { unmount } = render(
      <BluetoothHint userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0" />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "System Settings → Privacy & Security → Bluetooth → your browser on. Then quit the browser (⌘Q) and reopen it.",
    );
    unmount();
    render(<BluetoothHint userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" />);
    expect(screen.getByRole("note")).toHaveTextContent("Settings → Bluetooth & devices");
  });
});
