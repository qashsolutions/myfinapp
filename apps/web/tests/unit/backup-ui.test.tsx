import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { closeDb, deleteDb, openDb, seedDefaults } from "../../src/data/db.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { backupUiState } from "../../src/features/security/BackupSettings.tsx";
import {
  emptyBackup,
  type FakeBackup,
  type FakeBackupBlob,
  freeBilling,
  installFakeApi,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const T0 = "2026-10-01T10:00:00.000Z";
const settle = () => new Promise((r) => setTimeout(r, 30));

async function seedEntry(id: string, merchant: string) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.add({
    id,
    date: "2026-10-01",
    direction: "out",
    amount_cents: 1250,
    merchant,
    raw_description: merchant,
    clean_description: merchant.toUpperCase(),
    import_id: null,
    transfer_pair_id: null,
    category_id: null,
    account_id: "cash",
    source: "manual",
    is_transfer: false,
    is_recurring: false,
    receipt_id: null,
    split_parent_id: null,
    created_at: T0,
    updated_at: T0,
  });
}

describe("Encrypted backup", () => {
  beforeEach(() => {
    backupUiState.lastRecoveryKey = null;
  });

  it("Free sees the export reminder instead", async () => {
    installFakeApi({ session: readySession(), billing: freeBilling() });
    renderApp("/me/security");
    const section = await screen.findByRole("region", { name: "Encrypted backup" });
    expect(section).toHaveTextContent("Backup is part of Private and Connected");
    expect(within(section).getByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      "/me/plan",
    );
  });

  it("turns on: the key is made here, the recovery key is shown once, the first backup is ciphertext; a new device restores with the recovery key", async () => {
    const user = userEvent.setup();
    await seedEntry("e1", "Corner Market");
    const backup: FakeBackup = emptyBackup();
    const api = installFakeApi({ session: readySession(), backup });
    const { unmount } = renderApp("/me/security");
    const section = await screen.findByRole("region", { name: "Encrypted backup" });
    expect(await within(section).findByText(/Off\./)).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Turn on encrypted backup" }));
    const sheet = await screen.findByRole("dialog", { name: "Your recovery key" });
    const shown = backupUiState.lastRecoveryKey;
    expect(shown).toMatch(/^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
    expect(sheet).toHaveTextContent(shown ?? "");
    await user.click(within(sheet).getByRole("button", { name: "I've saved it" }));

    // The server holds wrapped keys and ciphertext only; nothing readable left the device
    expect(backup.key).toMatchObject({ key_version: 1 });
    expect(backup.key?.passkey_wrapped).toBeNull(); // the test authenticator has no PRF
    await waitFor(() => expect(backup.blobs).toHaveLength(1));
    const outbound = api.calls.filter((c) => c.path.startsWith("/api/backup"));
    for (const c of outbound) {
      const text = JSON.stringify(c.body ?? {});
      expect(text).not.toMatch(/Corner Market|1250|amount_cents|merchant/);
    }
    expect(backup.blobs[0]?.ciphertext).not.toContain("Corner");
    await waitFor(() => expect(within(section).getByText(/On\./)).toBeInTheDocument());
    expect(within(section).getByText(/Last backup: today/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Devices that sync" })).toHaveTextContent(
      "Safari on iPhone",
    );

    // Two copies it can't open land on top (say, from a stolen session): restore steps past them
    for (const id of ["junk1", "junk2"])
      backup.blobs.push({ ...(backup.blobs[0] as FakeBackupBlob), id, ciphertext: "AAAA" });

    // A new device: same account, empty database, the server's backup but no key
    unmount();
    await settle(); // let the shell's live queries wind down before the database goes
    closeDb("u1");
    await deleteDb("u1");
    resetEntitlements();
    installFakeApi({ session: readySession({ device_label: "Chrome on Mac" }), backup });
    renderApp("/me/security");
    const fresh = await screen.findByRole("region", { name: "Encrypted backup" });
    expect(await within(fresh).findByText(/Restore on this device/)).toBeInTheDocument();
    expect(
      within(fresh).queryByRole("button", {
        name: (n) => n.startsWith("Unlock with") && !n.includes("recovery"),
      }),
    ).toBeNull(); // no passkey copy
    await user.type(within(fresh).getByLabelText("Recovery key"), "WRONG-KEY");
    await user.click(within(fresh).getByRole("button", { name: "Unlock with the recovery key" }));
    expect(await within(fresh).findByRole("status")).toHaveTextContent(/doesn't match/);
    await user.clear(within(fresh).getByLabelText("Recovery key"));
    await user.type(within(fresh).getByLabelText("Recovery key"), shown ?? "");
    await user.click(within(fresh).getByRole("button", { name: "Unlock with the recovery key" }));
    await waitFor(() =>
      expect(within(fresh).getByRole("status")).toHaveTextContent(/Restored 1 item/),
    );
    expect(await openDb("u1").entries.get("e1")).toMatchObject({ merchant: "Corner Market" });
    await waitFor(() => expect(within(fresh).getByText(/On\./)).toBeInTheDocument());

    // Off: the server forgets everything; this device keeps its data
    await user.click(within(fresh).getByRole("button", { name: "Turn off backup" }));
    const off = await screen.findByRole("dialog", { name: "Turn off backup?" });
    await user.click(within(off).getByRole("button", { name: "Turn off backup" }));
    await waitFor(() => expect(backup.key).toBeNull());
    expect(backup.blobs).toEqual([]);
    expect(await openDb("u1").entries.count()).toBe(1);
    expect(await within(fresh).findByText(/Off\./)).toBeInTheDocument();
  });
});
