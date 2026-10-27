import { screen, within } from "@testing-library/react";
import { deviceLine } from "../../src/features/security/ActiveDevices.tsx";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const T = "2026-10-12T14:05:00Z";
const ENDED = "2026-10-10T09:30:00Z";

describe("Sign-in & security: devices, status and recent activity (October 13, 2026)", () => {
  it("live devices first with Sign out; ended sessions listed with how they ended", async () => {
    const api = installFakeApi({ session: readySession() });
    api.devices = [
      {
        id: "s1",
        label: "Chrome on Mac",
        created_at: T,
        last_seen_at: T,
        current: true,
        status: "current",
      },
      {
        id: "s2",
        label: "Safari on iPhone",
        created_at: T,
        last_seen_at: T,
        current: false,
        status: "active",
      },
      {
        id: "s3",
        label: "Firefox on Windows",
        created_at: T,
        last_seen_at: T,
        current: false,
        status: "signed_out_remote",
        ended_at: ENDED,
      },
      {
        id: "s4",
        label: "Chrome on Android",
        created_at: T,
        last_seen_at: T,
        current: false,
        status: "expired",
        ended_at: ENDED,
      },
    ];
    renderApp("/me/security");
    const live = await screen.findByRole("list", { name: "Signed in now" });
    expect(await within(live).findByText("Current")).toBeTruthy(); // the list fills in after load
    expect(within(live).getByRole("button", { name: "Sign out Safari on iPhone" })).toBeTruthy();
    const ended = await screen.findByRole("list", { name: "Ended in the last 30 days" });
    expect(within(ended).getByText(/Signed out from another device/)).toBeTruthy();
    expect(within(ended).getByText(/Session expired/)).toBeTruthy();
    expect(within(ended).queryByRole("button")).toBeNull(); // nothing to sign out
  });

  it("the device line says when it signed in, last active, or how it ended", () => {
    const base = { id: "x", label: "L", created_at: T, last_seen_at: T, current: false };
    expect(deviceLine({ ...base, current: true, status: "current" })).toMatch(
      /^This device · signed in /,
    );
    expect(deviceLine({ ...base, status: "active" })).toMatch(/^Signed in .* · last active /);
    expect(deviceLine({ ...base, status: "signed_out", ended_at: ENDED })).toMatch(/^Signed out /);
    expect(deviceLine({ ...base, status: "expired", ended_at: ENDED })).toMatch(
      /^Session expired /,
    );
  });

  it("recent activity names sign-ins, flags failed attempts, and never shows an IP", async () => {
    const api = installFakeApi({ session: readySession() });
    api.activity = [
      { at: T, kind: "sign_in_failed", device_label: null },
      { at: T, kind: "sign_in", device_label: "Chrome on Mac" },
      { at: T, kind: "passkey_added", device_label: null },
    ];
    renderApp("/me/security");
    const list = await screen.findByRole("list", { name: "Recent activity" });
    expect(await within(list).findByText("Failed sign-in attempt")).toBeTruthy();
    expect(within(list).getByText("Check")).toBeTruthy();
    expect(within(list).getByText(/Chrome on Mac · /)).toBeTruthy();
    expect(within(list).getByText("Passkey added")).toBeTruthy();
    expect(screen.getByText(/IP addresses are never stored in a readable form/)).toBeTruthy();
  });

  it("with one passkey, suggests adding a second", async () => {
    installFakeApi({
      session: readySession(),
      passkeys: [{ id: "pk1", label: "Mac passkey", created_at: T, last_used_at: T }],
    });
    renderApp("/me/security");
    expect(
      await screen.findByText(/Add a second passkey, on another device or a security key/),
    ).toBeTruthy();
  });
});
