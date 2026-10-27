import { startRegistration } from "@simplewebauthn/browser";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

function platformAuthenticator(available: boolean) {
  vi.stubGlobal("PublicKeyCredential", {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(available),
  });
}

async function linkFromComputer() {
  const api = installFakeApi();
  renderApp("/signin/phone");
  await screen.findByText("ABCD-EFG1");
  act(() => {
    if (api.deviceLink) api.deviceLink.status = "approved";
  });
  await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 });
  return api;
}

describe("B4: after the phone signs a computer in, offer the computer its own passkey", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks once, and Set up Touch ID adds a passkey", async () => {
    const user = userEvent.setup();
    platformAuthenticator(true);
    vi.mocked(startRegistration).mockClear();
    const api = await linkFromComputer();
    expect(
      await screen.findByRole("dialog", { name: "Use Touch ID here next time?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up Touch ID" }));
    expect(await screen.findByRole("dialog", { name: "All set" })).toBeInTheDocument();
    expect(startRegistration).toHaveBeenCalledTimes(1);
    expect(api.calls.some((c) => c.path === "/api/security/passkeys/register/verify")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sessionStorage.getItem("stackd.offer_passkey_here")).toBeNull();
  });

  it("Not now closes it for good in this tab", async () => {
    const user = userEvent.setup();
    platformAuthenticator(true);
    await linkFromComputer();
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sessionStorage.getItem("stackd.offer_passkey_here")).toBeNull();
  });

  it("isn't offered where the computer can't make a passkey", async () => {
    platformAuthenticator(false);
    await linkFromComputer();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isn't offered on an ordinary open of the app", async () => {
    platformAuthenticator(true);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
