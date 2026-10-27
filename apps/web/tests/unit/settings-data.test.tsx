import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { dbName, openDb, seedDefaults } from "../../src/data/db.ts";
import { crc32, toCsv, zipEntryNames, zipStore } from "../../src/data/export.ts";
import { exportState } from "../../src/features/settings/ExportData.tsx";
import {
  fakeMember,
  installFakeApi,
  ME,
  mayasGroup,
  readySession,
  VALID_CODE,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

describe("Settings + data rights", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a stored ZIP with a correct CRC and RFC 4180 CSV", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // the check value
    expect(
      toCsv([
        ["a", 'b "quoted"', "c,d"],
        [1, true, null],
      ]),
    ).toBe('a,"b ""quoted""","c,d"\r\n1,true,\r\n');
    const zip = zipStore(
      [
        { name: "a.txt", data: new TextEncoder().encode("hi") },
        { name: "dir/b.json", data: new TextEncoder().encode("{}") },
      ],
      TODAY,
    );
    expect(zipEntryNames(zip)).toEqual(["a.txt", "dir/b.json"]);
    expect(zip.subarray(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.subarray(zip.length - 22, zip.length - 18)).toEqual(
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    );
  });

  it("downloads all my data: one server request, the rest built on the device", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add({
      id: "e1",
      date: "2026-10-03",
      amount_cents: 4217,
      direction: "out",
      merchant: "Corner Market",
      clean_description: "CORNER MARKET",
      raw_description: null,
      category_id: "cat-groceries",
      account_id: "acct-cash",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    });
    await db.goals.add({
      id: "g1",
      kind: "save",
      title: "Travel",
      target_cents: 200000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "nia@example.com", display_name: "Nia", look: "modern" },
      }),
      groups: [
        { ...mayasGroup(), members: [...mayasGroup().members, fakeMember(ME, "Nia", 2000)] },
      ],
    });
    renderApp("/me/data");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(await screen.findByRole("button", { name: "Download all my data" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /stackd-export-2026-10-10\.zip \(7 files\)/,
      ),
    );
    expect(api.calls.filter((c) => c.path === "/api/account/export")).toHaveLength(1);
    const names = zipEntryNames(exportState.lastZip as Uint8Array);
    expect(names).toEqual([
      "profile.json",
      "entries.csv",
      "goals.json",
      "net_worth.json",
      "groups.json",
      "budgets.json",
      "settings.json",
    ]);
    const text = new TextDecoder().decode(exportState.lastZip as Uint8Array);
    expect(text).toContain("Corner Market");
    expect(text).toContain("42.17");
    expect(text).toContain("nia@example.com");
    expect(text).toContain("October savings"); // the group, from the server's part
    expect(text).toContain('"Travel"');
  });

  it("deletes the account: tick the box, a passkey check, the server call, then this device wipes its copy", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    localStorage.setItem("stackd.mode", "dark");
    const api = installFakeApi({ session: readySession() });
    renderApp("/me");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Delete account" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What is deleted" })).toHaveTextContent(
      "Former member",
    );
    const button = screen.getByRole("button", { name: "Delete forever" });
    expect(button).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I understand this permanently deletes my account and its data.",
      }),
    );
    expect(button).toBeEnabled();
    await user.click(button);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your account is deleted" }),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/account/delete")?.body).toEqual({
      confirm: "DELETE",
    });
    expect(await Dexie.exists(dbName("u1"))).toBe(false);
    expect(localStorage.getItem("stackd.mode")).toBeNull();
  });

  it("changes the email with a code sent to the new address", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "old@example.com", display_name: "Nia", look: "modern" },
      }),
    });
    renderApp("/me/email");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.type(await screen.findByLabelText("New email"), "taken@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has an account");
    await user.clear(screen.getByLabelText("New email"));
    await user.type(screen.getByLabelText("New email"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    const codeInput = await screen.findByLabelText("Code sent to new@example.com");
    expect(api.sentTo).toContain("new@example.com");
    await user.type(codeInput, "000000");
    await user.click(screen.getByRole("button", { name: "Verify and change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't right (4 tries left)");
    await user.clear(codeInput);
    await user.type(codeInput, VALID_CODE);
    await user.click(screen.getByRole("button", { name: "Verify and change" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your email is now new@example.com",
    );
  });

  it("manages accounts: add, set a balance, remove with its transactions", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/me/accounts");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(await screen.findByRole("region", { name: "Cash" })).toHaveTextContent("Not set");
    await user.click(screen.getByRole("button", { name: "+ Add an account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add an account" });
    await user.type(within(sheet).getByLabelText("Name"), "Everyday checking");
    await user.type(within(sheet).getByLabelText("Last 4 digits (optional)"), "4821");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    const card = await screen.findByRole("region", { name: "Everyday checking" });
    expect(card).toHaveTextContent("Checking ••4821");
    await user.click(within(card).getByRole("button", { name: "Set balance" }));
    const balance = await screen.findByRole("dialog", { name: "Balance in Everyday checking" });
    await user.type(within(balance).getByLabelText("Balance"), "2,100");
    await user.click(within(balance).getByRole("button", { name: "Save balance" }));
    await waitFor(() => expect(card).toHaveTextContent("$2,100.00 · you entered"));
    const account = (await db.accounts.toArray()).find((a) => a.label === "Everyday checking");
    await db.entries.add({
      id: "e1",
      date: "2026-10-03",
      amount_cents: 500,
      direction: "out",
      merchant: "X",
      clean_description: "X",
      raw_description: null,
      category_id: null,
      account_id: account?.id ?? "",
      source: "import",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    });
    await user.click(within(card).getByRole("button", { name: "Edit or remove" }));
    const edit = await screen.findByRole("dialog", { name: "Edit account" });
    await user.click(within(edit).getByRole("button", { name: "Remove account" }));
    await user.click(
      within(edit).getByRole("button", { name: "Really remove, with its transactions" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Everyday checking" })).toBeNull(),
    );
    expect(await db.entries.count()).toBe(0);
    expect(await db.balance_anchors.count()).toBe(0);
  });
});
