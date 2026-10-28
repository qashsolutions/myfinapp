import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeApi, readySession, VALID_CODE } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

describe("sign-up: email code, then the mandatory passkey", () => {
  it("walks Welcome → email → code → passkey → Home", async () => {
    const user = userEvent.setup();
    const fake = installFakeApi();
    renderApp("/");

    expect(
      await screen.findByRole("heading", { name: "Keep more of what you earn." }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    await user.click(screen.getByRole("link", { name: "Get started" }));

    expect(screen.getByRole("heading", { name: "What's your email?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a full email address, like you@example.com",
    );
    await user.type(screen.getByLabelText("Email address"), "Maya.R@Example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(fake.sentTo).toEqual(["maya.r@example.com"]);
    expect(screen.getByText("maya.r@example.com")).toBeInTheDocument();
    expect(screen.getByText(/resend in/)).toHaveTextContent("1:00");
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect(continueBtn).toBeDisabled();
    await user.click(screen.getByLabelText("6-digit code"));
    await user.paste(`code: ${VALID_CODE} ok`);
    expect(continueBtn).toBeEnabled();
    await user.click(continueBtn);

    expect(await screen.findByRole("heading", { name: /^Protect Qash with/ })).toBeInTheDocument();
    expect(fake.calls.at(-2)).toMatchObject({
      method: "POST",
      path: "/api/auth/otp/verify",
      body: { email: "maya.r@example.com", code: VALID_CODE, display_mode: "browser" },
    });
    await user.click(screen.getByRole("button", { name: "Create passkey" }));
    expect(await screen.findByRole("heading", { name: "You're protected" })).toBeInTheDocument();
    expect(fake.passkeys).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Continue to setup" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("says plainly when this network has made too many code checks", async () => {
    const user = userEvent.setup();
    installFakeApi({ verifyRateLimited: true });
    renderApp("/signin");
    await user.type(await screen.findByLabelText("Email address"), "maya.r@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText("6-digit code"), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many tries from this network. Wait a few minutes, then try again.",
    );
  });

  it("counts wrong codes down and then reports the lockout", async () => {
    const user = userEvent.setup();
    installFakeApi();
    renderApp("/signin");
    await user.type(await screen.findByLabelText("Email address"), "maya.r@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const input = await screen.findByLabelText("6-digit code");
    for (const left of [4, 3, 2, 1]) {
      await user.type(input, "000000");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`,
      );
    }
    await user.type(input, "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many wrong tries. Codes pause for 15 minutes.",
    );
    expect(
      screen.getByText("After 5 wrong tries, codes pause for 15 minutes."),
    ).toBeInTheDocument();
  });

  it("a passkey check that is cancelled explains itself and can be retried", async () => {
    const user = userEvent.setup();
    const { startRegistration } = await import("@simplewebauthn/browser");
    vi.mocked(startRegistration).mockRejectedValueOnce(
      Object.assign(new Error("cancel"), { name: "NotAllowedError" }),
    );
    installFakeApi({
      session: readySession({ has_passkeys: false, locked: true, passkey_verified_at: null }),
    });
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Create passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No passkey was created. Tap Create passkey to try again.",
    );
    await user.click(screen.getByRole("button", { name: "Create passkey" }));
    expect(await screen.findByRole("heading", { name: "You're protected" })).toBeInTheDocument();
  });
});

describe("returning user on a new device", () => {
  it("is asked to confirm with the passkey, from another device if it isn't here", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession({ locked: true, passkey_verified_at: null }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    // Adding a passkey needs an unlocked session, so a locked one is never offered it
    expect(screen.queryByRole("button", { name: /Set up a passkey/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/No passkey on this device\? Tap Unlock and pick the device that has it/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Unlock with/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ }),
    ).toBeInTheDocument();
  });
});

describe("auto-lock", () => {
  it("locks after 5 minutes without activity and unlocks with the passkey", async () => {
    // Fake only what the lock logic uses, so Testing Library's polling and user-event keep
    // real timers and the test stays deterministic on slow runners.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      installFakeApi({ session: readySession() });
      renderApp("/budget");
      expect(await screen.findByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4 * 60 * 1000);
      });
      expect(screen.getByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(90 * 1000);
      });
      expect(screen.getByRole("heading", { name: "Qash is locked" })).toBeInTheDocument();
      expect(document.title).toBe("Qash is locked");
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /^Unlock with/ }));
      expect(await screen.findByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a `locked` answer from any request shows the lock screen", async () => {
    const fake = installFakeApi({ session: readySession(), passkeys: [] });
    renderApp("/me/security");
    await screen.findByRole("heading", { level: 1, name: "Security & backup" });
    fake.session = { ...fake.session, locked: true };
    // the next data call answers 403 locked; the app reacts without a reload
    await act(async () => {
      await globalThis.fetch("http://localhost/api/security/devices");
    });
    // trigger through the real client so the signal fires
    const { api } = await import("../../src/data/api.ts");
    await act(async () => {
      await api.GET("/api/security/devices");
    });
    expect(await screen.findByRole("heading", { name: "Qash is locked" })).toBeInTheDocument();
  });
});

describe("signed-in screens stay out of reach when signed out", () => {
  it("redirects to Welcome, and Welcome redirects back once ready", async () => {
    const fake = installFakeApi();
    renderApp("/goals");
    expect(
      await screen.findByRole("heading", { name: "Keep more of what you earn." }),
    ).toBeInTheDocument();
    fake.session = readySession();
    renderApp("/welcome");
    expect(
      await screen.findAllByRole("heading", {
        level: 1,
        name: /^Good (morning|afternoon|evening)/,
      }),
    ).not.toHaveLength(0);
  });

  it("log out from Me returns to Welcome, which recognises who used this device", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/me");
    const account = await screen.findByRole("region", { name: "Account" });
    await user.click(within(account).getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back." })).toBeInTheDocument();
    // Only a masked address is kept on the device, never the full email.
    expect(screen.getByText("ma•••@example.com")).toBeInTheDocument();
    expect(localStorage.getItem("stackd.last_account")).not.toContain("maya.r@");
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull());
    // "Use a different account" forgets it and goes to the email sign-in.
    await user.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(localStorage.getItem("stackd.last_account")).toBeNull();
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
