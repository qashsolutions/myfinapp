import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { codeFromScan, completeCode, tidyCode } from "../../src/features/auth/linkCode.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const pending = () => ({ code: "ABCD-EFGH", status: "pending" as const });

describe("Link a device, the phone's screen (B3, October 19, 2026)", () => {
  it("a scanned code opens the approval: names the computer, a passkey check, then approved", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), deviceLink: pending() });
    renderApp("/link?code=ABCD-EFGH");
    expect(
      await screen.findByRole("heading", { name: "Sign in on this computer?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Chrome on Mac")).toBeInTheDocument();
    expect(screen.getByText(/Never approve a code someone sent you/)).toBeInTheDocument();
    expect(screen.queryByText("It's on a different network")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Approve with/ }));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/Chrome on Mac is signing in now/)).toBeInTheDocument();
    const call = api.calls.find((c) => c.path === "/api/auth/link/approve");
    expect(call?.body).toEqual({ code: "ABCD-EFGH", confirm_different_network: false });
    expect(api.deviceLink?.status).toBe("approved");
  });

  it("a different network warns, and Approve waits until the person confirms it's theirs", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession(),
      deviceLink: pending(),
      deviceLinkSameNetwork: false,
    });
    renderApp("/link?code=ABCD-EFGH");
    expect(await screen.findByText("It's on a different network")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: /^Approve with/ });
    expect(approve).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "It's my computer, and I'm using it now" }),
    );
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    const call = api.calls.find((c) => c.path === "/api/auth/link/approve");
    expect(call?.body).toEqual({ code: "ABCD-EFGH", confirm_different_network: true });
  });

  it("deny says nobody was signed in", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), deviceLink: pending() });
    renderApp("/link?code=ABCD-EFGH");
    await user.click(await screen.findByRole("button", { name: "No, deny" }));
    expect(await screen.findByText("Nobody was signed in.")).toBeInTheDocument();
    expect(api.deviceLink?.status).toBe("denied");
  });

  it("a request already answered elsewhere is never shown as denied (answered once)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), deviceLink: pending() });
    renderApp("/link?code=ABCD-EFGH");
    const deny = await screen.findByRole("button", { name: "No, deny" });
    if (api.deviceLink) api.deviceLink.status = "approved"; // approved from another tab
    await user.click(deny);
    expect(await screen.findByText("That code has expired")).toBeInTheDocument();
    expect(screen.queryByText("Nobody was signed in.")).toBeNull();
    expect(api.deviceLink?.status).toBe("approved");
  });

  it("deny with the network gone is never shown as denied: the computer is still waiting (invariant 35)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), deviceLink: pending() });
    renderApp("/link?code=ABCD-EFGH");
    const deny = await screen.findByRole("button", { name: "No, deny" });
    api.offline = true;
    await user.click(deny);
    expect(await screen.findByText("You're offline. Try again when connected.")).toBeVisible();
    expect(screen.queryByText("Nobody was signed in.")).toBeNull();
    expect(deny).toBeEnabled();
  });

  it("from Me: type the code; an unknown or expired one says to get a new one", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession(), deviceLink: pending() });
    renderApp("/me");
    await user.click(await screen.findByRole("link", { name: /Link a device/ }));
    const field = await screen.findByLabelText("Or type the code");
    await user.type(field, "abcd efgh");
    expect(field).toHaveValue("ABCD-EFGH");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in on this computer?" }),
    ).toBeInTheDocument();
  });

  it("an expired code says so", async () => {
    installFakeApi({ session: readySession(), deviceLink: null });
    renderApp("/link?code=ABCD-EFGH");
    expect(await screen.findByText("That code has expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter a new code" })).toBeInTheDocument();
  });

  it("a half-typed code doesn't go to the server", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/link");
    await user.type(await screen.findByLabelText("Or type the code"), "ABC");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Codes are 8 letters and numbers");
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/api/auth/link/lookup")).toBe(false),
    );
  });

  it("signed out (the phone's camera opened it in the browser): how to approve in the app", async () => {
    installFakeApi();
    renderApp("/link?code=ABCD-EFGH");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Approve in the Qash app" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in first" })).toHaveAttribute("href", "/welcome");
  });
});

describe("link codes", () => {
  it("tidies typing and only accepts whole codes from the alphabet", () => {
    expect(tidyCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(tidyCode("ab")).toBe("AB");
    expect(completeCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(completeCode("ABCD-EFG1")).toBeNull(); // no 1, 0, O or I in codes
    expect(completeCode("ABCD")).toBeNull();
  });

  it("reads only this app's own link out of a scanned QR", () => {
    const origin = "https://app.qash.solutions";
    expect(codeFromScan("https://app.qash.solutions/link?code=ABCDEFGH", origin)).toBe("ABCD-EFGH");
    expect(codeFromScan("https://evil.example/link?code=ABCDEFGH", origin)).toBeNull();
    expect(codeFromScan("https://app.qash.solutions/other?code=ABCDEFGH", origin)).toBeNull();
    expect(codeFromScan("ABCD-EFGH", origin)).toBe("ABCD-EFGH");
    expect(codeFromScan("hello", origin)).toBeNull();
  });
});
