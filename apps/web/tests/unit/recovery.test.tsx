import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import {
  emptyHouseholds,
  freeBilling,
  installFakeApi,
  RECOVERY_CODE,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

// Getting back in without a passkey (owner decision, October 30, 2026; invariant 74).

/** A new device signed in with an email code: the account has passkeys, this one used none. */
const emailOnly = () => readySession({ locked: true, passkey_verified_at: null });

describe("Getting back in without a passkey", () => {
  it("a lost-passkey device waits 24 hours, then makes a new passkey and opens", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: emailOnly() });
    const view = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Lost your passkeys?" }));
    expect(await screen.findByRole("heading", { name: "Get back in" })).toBeInTheDocument();
    expect(screen.getByText(/create a new passkey here in 24 hours/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ask / })).toBeNull(); // no partner
    await user.click(screen.getByRole("button", { name: "Wait 24 hours" }));
    expect(await screen.findByRole("heading", { name: "On its way" })).toBeInTheDocument();
    expect(screen.getByText(/You can create a new passkey here from .* at /)).toBeInTheDocument();

    // A day later the device opens on where it stands, and the new passkey lets it in
    view.unmount();
    api.recovery.status = "ready";
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "You're ready" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Create a new passkey" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/api/security/passkeys/register/verify")).toBe(true),
    );
    expect(api.recovery.status).toBe("none");
  });

  it("asks the partner on the same plan, never by name: a code to read out", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: emailOnly() });
    api.recovery.partner_available = true;
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Lost your passkeys?" }));
    expect(
      await screen.findByText("Your partner can let you in now, from their Qash."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ask my partner to let me in" }));
    expect(await screen.findByText("Read this code to your partner:")).toBeInTheDocument();
    expect(screen.getByText(`${RECOVERY_CODE.slice(0, 3)} ${RECOVERY_CODE.slice(3)}`)).toHaveClass(
      "recover__code",
    );
    expect(screen.getByText(/goes to Me, then Household, and types it in/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Asha");
    // A reload keeps the code read out
    expect(sessionStorage.getItem("qash.recovery_code")).toBe(RECOVERY_CODE);
    // "I found my passkey" cancels and goes back to Unlock
    await user.click(screen.getByRole("button", { name: "I found my passkey" }));
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(api.recovery.status).toBe("none");
  });

  it("no lost-passkey path on a device that has unlocked before", async () => {
    installFakeApi({ session: readySession({ locked: true }) });
    renderApp("/");
    await screen.findByRole("button", { name: /^Unlock with/ });
    expect(screen.queryByRole("button", { name: "Lost your passkeys?" })).toBeNull();
  });

  it("the owner sees a waiting request on Security and cancels it", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.recovery.status = "waiting";
    api.recovery.ready_at = new Date(Date.now() + 20 * 3600_000).toISOString();
    renderApp("/me/security");
    const card = await screen.findByRole("alert", { name: "Someone asked to get back in" });
    expect(card).toHaveTextContent(/without a passkey/);
    await user.click(within(card).getByRole("button", { name: "Cancel it" }));
    expect(await screen.findByText("Cancelled. Nothing changed.")).toBeInTheDocument();
    expect(api.recovery.status).toBe("none");
  });

  it("the partner types the code on Household to let them in", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const now = new Date().toISOString();
    const households = emptyHouseholds();
    households.rows.push({
      id: "hh1",
      owner_id: "u1",
      created_at: now,
      members: [
        { user_id: "u1", display_name: "Maya R.", initial: "M", joined_at: now, left_at: null },
        { user_id: "u2", display_name: "Dev P.", initial: "D", joined_at: now, left_at: null },
      ],
      invite: null,
      blobs: [],
    });
    const api = installFakeApi({
      session: readySession(),
      billing: { ...freeBilling(), plan: "connected" },
      households,
    });
    api.recovery.asked = [{ id: "r1", name: "Dev", device_label: "Chrome on Mac", asked_at: now }];
    api.recovery.setting = { on: false, possible: true, partner_name: "Dev" };
    renderApp("/me/household");
    const card = await screen.findByRole("alert", { name: "Dev asked for help getting back in" });
    const approve = within(card).getByRole("button", { name: "Let Dev in" });
    expect(approve).toBeDisabled();
    await user.type(within(card).getByLabelText("Their code"), "111 111");
    await user.click(approve);
    expect(
      await within(card).findByText(/That code doesn't match.*\(4 tries left\)/),
    ).toBeInTheDocument();
    await user.clear(within(card).getByLabelText("Their code"));
    await user.type(within(card).getByLabelText("Their code"), "482 913");
    await user.click(approve);
    expect(await screen.findByText("Done. Dev can create a new passkey now.")).toBeInTheDocument();

    // And the switch that lets Dev help this person, the other way round
    const sw = screen.getByRole("switch", { name: "Let Dev help me get back in" });
    await user.click(sw);
    await waitFor(() => expect(api.recovery.setting.on).toBe(true));
  });
});
