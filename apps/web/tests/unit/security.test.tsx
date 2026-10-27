import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const now = new Date().toISOString();
const passkeys = [
  { id: "pk1", label: "iPhone passkey", created_at: now, last_used_at: now },
  { id: "pk2", label: "MacBook passkey", created_at: now, last_used_at: null },
];
const devices = [
  {
    id: "s1",
    label: "Safari on iPhone · Home Screen app",
    created_at: now,
    last_seen_at: now,
    current: true,
    status: "current",
  },
  {
    id: "s2",
    label: "Chrome on Mac",
    created_at: now,
    last_seen_at: now,
    current: false,
    status: "active",
  },
];

describe("Me → Security & backup", () => {
  it("lists passkeys and devices from the server", async () => {
    installFakeApi({ session: readySession(), passkeys, devices });
    renderApp("/me/security");
    const pk = await screen.findByRole("region", { name: "Passkeys" });
    expect(await within(pk).findByText("iPhone passkey")).toBeInTheDocument();
    expect(within(pk).getByText("Created today · used today")).toBeInTheDocument();
    const dev = screen.getByRole("region", { name: "Signed-in devices" });
    expect(within(dev).getByText(/^This device · signed in /)).toBeInTheDocument();
    expect(within(dev).getByText("Current")).toBeInTheDocument();
    expect(within(dev).getByRole("button", { name: "Sign out Chrome on Mac" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/me");
  });

  it("signing out another device needs a fresh passkey check (the step-up sheet)", async () => {
    const user = userEvent.setup();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fake = installFakeApi({
      session: readySession({ passkey_verified_at: tenMinutesAgo }),
      passkeys,
      devices,
      stepUpStale: true,
    });
    renderApp("/me/security");
    await user.click(await screen.findByRole("button", { name: "Sign out Chrome on Mac" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(sheet).toHaveTextContent(
      "Signing out a device needs a quick check, even while the app is unlocked.",
    );
    expect(sheet).toHaveTextContent("We'll also email you that this happened.");
    await user.click(within(sheet).getByRole("button", { name: /^Confirm with/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.devices.map((d) => d.id)).toEqual(["s1"]);
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Sign out Chrome on Mac" })).toBeNull();
  });

  it("cancelling the step-up check changes nothing", async () => {
    const user = userEvent.setup();
    const fake = installFakeApi({
      session: readySession({
        passkey_verified_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }),
      passkeys,
      devices,
      stepUpStale: true,
    });
    renderApp("/me/security");
    await user.click(await screen.findByRole("button", { name: "Sign out Chrome on Mac" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.devices).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("a fresh passkey check skips the sheet, and the last passkey cannot be removed", async () => {
    const user = userEvent.setup();
    const fake = installFakeApi({ session: readySession(), passkeys, devices });
    renderApp("/me/security");
    await user.click(await screen.findByRole("button", { name: "Remove MacBook passkey" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(fake.passkeys.map((p) => p.id)).toEqual(["pk1"]));
    expect(
      await screen.findByRole("button", { name: "Remove iPhone passkey" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove iPhone passkey" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Keep at least one passkey. Add another before removing this one.",
    );
    expect(fake.passkeys).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "+ Add a passkey" }));
    await waitFor(() => expect(screen.getAllByText("Created today · used today")).toHaveLength(2));
    expect(fake.passkeys).toHaveLength(2);
  });
});
