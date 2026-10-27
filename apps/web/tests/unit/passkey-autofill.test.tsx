import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeApi } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

describe("passkey suggestion in the email box (October 19, 2026)", () => {
  afterEach(() => {
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
  });

  it("asks the browser for a passkey to offer in the email field, and picking one signs in", async () => {
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(true);
    vi.mocked(startAuthentication).mockClear();
    const api = installFakeApi();
    renderApp("/signin");
    const field = await screen.findByLabelText("Email address");
    expect(field).toHaveAttribute("autocomplete", "email webauthn");
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startAuthentication).mock.calls[0]?.[0]).toMatchObject({
      useBrowserAutofill: true,
    });
    // The fake browser "picks" the passkey: verify, session refresh, Home
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/api/auth/passkey/verify")).toBe(true);
  });

  it("cancels the waiting request when the person asks for an email code instead", async () => {
    const user = userEvent.setup();
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(true);
    vi.mocked(startAuthentication).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(WebAuthnAbortService.cancelCeremony).mockClear();
    installFakeApi();
    renderApp("/signin");
    await user.type(await screen.findByLabelText("Email address"), "maya@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your email" }),
    ).toBeInTheDocument();
    expect(WebAuthnAbortService.cancelCeremony).toHaveBeenCalled();
  });

  it("does nothing where the browser can't suggest passkeys", async () => {
    vi.mocked(startAuthentication).mockClear();
    installFakeApi();
    renderApp("/signin");
    await screen.findByLabelText("Email address");
    await new Promise((r) => setTimeout(r, 20));
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});
