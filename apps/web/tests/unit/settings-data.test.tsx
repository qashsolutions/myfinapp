import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { dbName, openDb, seedDefaults } from "../../src/data/db.ts";
import { collectExport, crc32, toCsv, zipEntryNames, zipStore } from "../../src/data/export.ts";
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

  it("the export holds everything the person made: milestones, templates, column matches, kept statements, and how entries split and pair", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const row = {
      date: "2026-10-03",
      direction: "out" as const,
      merchant: "Corner Market",
      clean_description: "CORNER MARKET",
      raw_description: null,
      category_id: "cat-groceries",
      account_id: "acct-cash",
      source: "linked" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    };
    await db.entries.bulkAdd([
      {
        ...row,
        id: "e1",
        amount_cents: 3000,
        fingerprint: "fp-e1",
        provider_txn_id: "txn-9",
        pending: true,
        transfer_pair_id: "e3",
      },
      { ...row, id: "e2", amount_cents: 1000, split_parent_id: "e1" },
    ]);
    await db.goal_milestones.add({
      id: "g1:5000",
      goal_id: "g1",
      bps: 5000,
      label: "Halfway",
      target_cents: 1000,
      reached_at: null,
    });
    await db.goal_templates.add({
      id: "t1",
      name: "Trip fund",
      payload: {
        kind: "save",
        title: "Trip fund",
        target_cents: 50000,
        months: 6,
        cadence: null,
        per_period_cents: null,
        is_ongoing: false,
        why_text: null,
        milestones_bps: [],
      },
      created_at: "2026-10-01T00:00:00Z",
    });
    await db.csv_mappings.add({
      account_id: "acct-cash",
      mapping: {
        date: 0,
        description: 1,
        amount: 2,
        debit: null,
        credit: null,
        balance: null,
        sign: "negative_out",
        date_format: "YYYY-MM-DD",
      } as never,
      updated_at: "2026-10-01T00:00:00Z",
    });
    const statement = {
      id: "f1",
      kind: "statement" as const,
      import_id: "imp-1",
      name: "october/statement.csv",
      type: "text/csv",
      size: 18,
      blob: new Blob(["date,desc,amount\n"], { type: "text/csv" }),
      created_at: "2026-10-01T00:00:00Z",
    };
    await db.files.add(statement);
    // fake-indexeddb hands a Blob back as a plain object; the browser keeps it a Blob
    const where = db.files.where.bind(db.files);
    vi.spyOn(db.files, "where").mockImplementation(((index: string) =>
      index === "kind"
        ? { equals: () => ({ toArray: async () => [statement] }) }
        : where(index)) as never);
    const files = await collectExport(db, null, TODAY.toISOString());
    const byName = new Map(files.map((f) => [f.name, new TextDecoder().decode(f.data)]));
    const goals = JSON.parse(byName.get("goals.json") ?? "{}");
    expect(goals.milestones.map((m: { id: string }) => m.id)).toEqual(["g1:5000"]);
    expect(goals.templates.map((t: { name: string }) => t.name)).toEqual(["Trip fund"]);
    const settings = JSON.parse(byName.get("settings.json") ?? "{}");
    expect(settings.csv_mappings[0].account_id).toBe("acct-cash");
    expect(settings.statement_files).toEqual([
      expect.objectContaining({
        id: "f1",
        import_id: "imp-1",
        path: "statements/f1-october_statement.csv",
      }),
    ]);
    expect(byName.get("statements/f1-october_statement.csv")).toBe("date,desc,amount\n");
    const [header, first, second] = (byName.get("entries.csv") ?? "").split("\r\n");
    const cols = header?.split(",") ?? [];
    for (const c of [
      "split_parent_id",
      "transfer_pair_id",
      "pending",
      "fingerprint",
      "provider_txn_id",
    ])
      expect(cols).toContain(c);
    const cell = (line: string | undefined, c: string) => line?.split(",")[cols.indexOf(c)];
    expect(cell(first, "fingerprint")).toBe("fp-e1");
    expect(cell(first, "provider_txn_id")).toBe("txn-9");
    expect(cell(first, "pending")).toBe("true");
    expect(cell(first, "transfer_pair_id")).toBe("e3");
    expect(cell(second, "split_parent_id")).toBe("e1");
    expect(cell(second, "pending")).toBe("false");
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

  it("a linked account's balance names its bank and sync, never 'you entered' (invariant 64)", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.accounts.add({
      id: "acc-linked",
      label: "Plaid Checking",
      type: "checking",
      last4: "0000",
      institution: "First Platypus Bank",
      currency: "USD",
      created_at: "2026-10-01T00:00:00Z",
      linked: { connection_id: "c1", account_id: "pa1" },
    });
    await db.balance_anchors.add({
      id: "lnk-bal-acc-linked-2026-10-10",
      account_id: "acc-linked",
      as_of: "2026-10-10",
      balance_cents: 110_00,
      source: "linked",
      created_at: new Date("2026-10-10T11:55:00").toISOString(),
    });
    installFakeApi({ session: readySession() });
    renderApp("/me/accounts");
    const card = await screen.findByRole("region", { name: "Plaid Checking" });
    await waitFor(() =>
      expect(card).toHaveTextContent("$110.00 · from First Platypus Bank · synced 5 min ago"),
    );
    expect(card).toHaveTextContent("Linked · synced 5 min ago");
    expect(card).toHaveTextContent("Linked to First Platypus Bank");
    expect(card).not.toHaveTextContent("you entered");
    expect(card).not.toHaveTextContent("Never imported");
    expect(card).not.toHaveTextContent("Manual balance");
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
      receipt_id: "r1",
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    });
    // What else hangs off the account: a receipt photo, a card's details, a net worth choice
    const accountId = account?.id ?? "";
    await db.files.add({
      id: "f-r1",
      kind: "receipt",
      import_id: null,
      name: "receipt.jpg",
      type: "image/jpeg",
      size: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      created_at: "2026-10-03T00:00:00Z",
    });
    await db.receipts.add({
      id: "r1",
      entry_id: "e1",
      file_id: "f-r1",
      status: "confirmed",
      purge_after: null,
      purged_at: null,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    });
    await db.card_details.add({
      account_id: accountId,
      statement_balance_cents: 1000,
      statement_date: null,
      due_date: null,
      minimum_cents: null,
      last_payment_cents: null,
      last_payment_date: null,
      limit_cents: null,
      apr_bps: null,
      is_overdue: false,
      updated_at: "2026-10-03T00:00:00Z",
    });
    await db.net_worth_items.add({
      id: "nw-acct",
      kind: "asset",
      group: "Cash",
      label: "Everyday checking",
      value_cents: null,
      source: "account",
      ref_id: accountId,
      included: false,
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
    expect(await db.receipts.count()).toBe(0);
    expect(await db.files.get("f-r1")).toBeUndefined();
    expect(await db.card_details.get(accountId)).toBeUndefined();
    expect(await db.net_worth_items.get("nw-acct")).toBeUndefined();
    expect(await db.tombstones.get(["net_worth_items", "nw-acct"])).toMatchObject({
      id: "nw-acct",
    });
  });
});
