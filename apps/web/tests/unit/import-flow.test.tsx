import { readFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { parseAmount } from "../../src/engine/bridge.ts";
import { findTransferPartner } from "../../src/features/entries/transfers.ts";
import { commitImport, parseFile, prepareRows } from "../../src/features/imports/importFlow.ts";
import { applyMapping, guessMapping } from "../../src/importers/csv.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const fixture = (name: string) => readFileSync(`${process.cwd()}/tests/fixtures/${name}`, "utf8");
const fileOf = (name: string, type: string) => new File([fixture(name)], name, { type });

async function start(path = "/import") {
  const fake = installFakeApi({ session: readySession() });
  renderApp(path);
  await screen.findByRole("heading", { level: 1, name: "Import a statement" });
  return fake;
}

/**
 * Background traffic the shell makes on every screen: the session read, the notification
 * settings read, the groups list, the alert schedule (dates, types and keys only) and the plan's
 * limits. Anything else during an import is a leak.
 */
const BACKGROUND = new Set([
  "/api/auth/session",
  "/api/notifications/settings",
  "/api/groups",
  "/api/alerts/schedule",
  "/api/billing/entitlements",
]);
const onlySessionReads = (calls: Array<{ method: string; path: string; body?: unknown }>) => {
  for (const c of calls)
    if (c.path === "/api/alerts/schedule")
      expect(JSON.stringify(c.body ?? {})).not.toMatch(/cents|amount|merchant|account|balance/i);
  return calls.filter((c) => !BACKGROUND.has(c.path));
};

describe("statement import, read on the device", () => {
  it("CSV: file and account, match columns, review, import; nothing is uploaded", async () => {
    const user = userEvent.setup();
    const fake = await start();
    await user.upload(
      screen.getByLabelText(/Choose a statement file/),
      fileOf("statement_oct.csv", "text/csv"),
    );
    expect(await screen.findByText("statement_oct.csv · 4 rows")).toBeInTheDocument();
    expect(
      screen.getByText("Read on this device. The file is never uploaded."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ New account" }));
    await user.type(screen.getByLabelText("Account name"), "Everyday checking");
    await user.type(screen.getByLabelText("Last 4 digits (optional)"), "4821");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    expect(await screen.findByRole("radio", { name: /Everyday checking/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Read file" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Match columns" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toHaveDisplayValue("Posting Date");
    expect(screen.getByLabelText("Amount")).toHaveDisplayValue("Amount");
    expect(screen.getByLabelText("Balance (optional)")).toHaveDisplayValue("Balance");
    expect(screen.getByLabelText("Date format")).toHaveDisplayValue("MM/DD/YYYY");
    const preview = await screen.findByRole("list", { name: "Preview of the first rows" });
    expect(await within(preview).findByText("PAYMENT TO CARD ••1173")).toBeInTheDocument();
    expect(within(preview).getByText("+$2,400.00")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Remember this for Everyday checking" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Looks right" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Review import" }),
    ).toBeInTheDocument();
    const stats = screen.getByRole("group", { name: "Rows" });
    expect(
      within(stats)
        .getAllByText(/^\d+$/)
        .map((e) => e.textContent),
    ).toEqual(["4", "4", "0"]);
    const card = screen.getByRole("group", { name: "PAYMENT TO CARD ••1173: transfer?" });
    expect(within(card).getByRole("button", { name: "Yes, transfer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent("Categorized automatically3");
    expect(summary).toHaveTextContent("Need a category0");
    expect(summary).toHaveTextContent("Ending balance (Oct 8)$2,100.00");
    expect(screen.getByText(/Account number masked to ••4821/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import 4 transactions" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("ACME PAYROLL")).toBeInTheDocument();
    const db = openDb("u1");
    const entries = await db.entries.toArray();
    expect(entries).toHaveLength(4);
    expect(entries.find((e) => e.merchant === "PAYMENT TO CARD ••1173")).toMatchObject({
      is_transfer: true,
      category_id: null,
      source: "import",
      direction: "out",
      amount_cents: 120000,
    });
    expect(entries.find((e) => e.merchant === "CORNER MKT #214")?.category_id).toBe(
      "cat-groceries",
    );
    expect(entries.find((e) => e.merchant === "ACME PAYROLL")).toMatchObject({
      direction: "in",
      category_id: "cat-paycheck",
    });
    expect(entries.every((e) => e.fingerprint && e.import_id && e.raw_description)).toBe(true);
    expect(await db.statement_imports.toArray()).toMatchObject([
      {
        format: "csv",
        rows_found: 4,
        rows_added: 4,
        rows_skipped: 0,
        ending_balance_cents: 210000,
        file_name: "statement_oct.csv",
      },
    ]);
    expect(await db.csv_mappings.count()).toBe(1);
    expect(await db.balance_anchors.toArray()).toMatchObject([
      { as_of: "2026-10-08", balance_cents: 210000, source: "statement" },
    ]);
    expect(await db.files.toArray()).toMatchObject([
      { kind: "statement", name: "statement_oct.csv" },
    ]);
    expect(onlySessionReads(fake.calls)).toEqual([]);
  });

  it("re-uploading the same statement creates no duplicates", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const parsed = await parseFile("statement_oct.csv", fixture("statement_oct.csv"));
    const table = parsed.csv as NonNullable<typeof parsed.csv>;
    const mapping = guessMapping(table);
    const { rows } = await applyMapping(table, mapping, parseAmount);
    const first = await prepareRows(db, "acct-cash", rows);
    expect(first).toMatchObject({ found: 4, fresh: 4, duplicates: 0 });
    const cash = await db.accounts.get("acct-cash");
    if (!cash) throw new Error("no cash account");
    await commitImport(db, {
      account: cash,
      format: "csv",
      fileName: "statement_oct.csv",
      prepared: first,
      transfers: new Set(),
      mapping,
      rememberMapping: true,
    });
    expect(await db.entries.count()).toBe(4);

    const again = await prepareRows(db, "acct-cash", rows);
    expect(again).toMatchObject({ found: 4, fresh: 0, duplicates: 4 });

    const fake = await start();
    await user.upload(
      screen.getByLabelText(/Choose a statement file/),
      fileOf("statement_oct.csv", "text/csv"),
    );
    await user.click(await screen.findByRole("radio", { name: /^Cash/ }));
    await user.click(screen.getByRole("button", { name: "Read file" }));
    await screen.findByRole("heading", { level: 1, name: "Match columns" }); // remembered mapping, still shown once
    await user.click(await screen.findByRole("button", { name: "Looks right" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Review import" }),
    ).toBeInTheDocument();
    const stats = screen.getByRole("group", { name: "Rows" });
    expect(
      within(stats)
        .getAllByText(/^\d+$/)
        .map((e) => e.textContent),
    ).toEqual(["4", "0", "4"]);
    expect(screen.getByRole("button", { name: "Nothing new to import" })).toBeDisabled();
    expect(await db.entries.count()).toBe(4);
    expect(onlySessionReads(fake.calls)).toEqual([]);
  });

  it("OFX skips column matching, masks the account number, anchors the balance, and finds the other side of a transfer", async () => {
    const user = userEvent.setup();
    const db0 = openDb("u1");
    await seedDefaults(db0);
    await db0.entries.add({
      id: "chk-payment",
      date: "2026-10-06",
      amount_cents: 120000,
      direction: "out",
      merchant: "PAYMENT TO CARD ••1173",
      clean_description: "PAYMENT TO CARD ••1173",
      raw_description: null,
      category_id: null,
      account_id: "acct-cash",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    const fake = await start();
    await user.upload(
      screen.getByLabelText(/Choose a statement file/),
      fileOf("card_oct.ofx", "application/x-ofx"),
    );
    expect(await screen.findByText("card_oct.ofx · 2 rows")).toBeInTheDocument();
    // The statement names its account: one tap makes it (October 19, 2026)
    await user.click(
      await screen.findByRole("button", { name: "+ New account: Rewards Bank ••1173 · Card" }),
    );
    await waitFor(async () =>
      expect((await openDb("u1").accounts.toArray()).find((a) => a.last4 === "1173")).toMatchObject(
        {
          label: "Rewards Bank Card",
          type: "credit_card",
          institution: "Rewards Bank",
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Rewards Bank Card/ })).toBeChecked(),
    );
    await user.click(screen.getByRole("button", { name: "Read file" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Review import" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Match columns" })).toBeNull();
    const card = screen.getByRole("group", { name: "PAYMENT - THANK YOU: transfer?" });
    expect(within(card).getByRole("button", { name: "Yes, transfer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText(/Oct 6 · matches −\$1,200\.00 on Cash/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "No, income" }));
    expect(within(card).getByRole("button", { name: "No, income" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent("Ending balance (Oct 8)−$312.45");
    expect(screen.getByText(/Account number masked to ••1173/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import 2 transactions" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();

    const db = openDb("u1");
    const account = (await db.accounts.toArray()).find((a) => a.label === "Rewards Bank Card");
    expect(account).toMatchObject({
      type: "credit_card",
      last4: "1173",
      institution: "Rewards Bank",
    });
    const entries = await db.entries.toArray();
    expect(entries.find((e) => e.merchant.startsWith("NETFLIX"))).toMatchObject({
      category_id: "cat-subscriptions",
      direction: "out",
      amount_cents: 1499,
    });
    expect(entries.find((e) => e.merchant === "PAYMENT - THANK YOU")).toMatchObject({
      is_transfer: false,
      direction: "in",
    });
    expect(await db.balance_anchors.toArray()).toMatchObject([
      { balance_cents: -31245, as_of: "2026-10-08" },
    ]);
    expect(await db.statement_imports.toArray()).toMatchObject([
      { format: "ofx", period_start: "2026-10-01", period_end: "2026-10-08" },
    ]);
    expect(onlySessionReads(fake.calls)).toEqual([]);
  });

  it("a confirmed transfer marks both sides and links them, so neither counts as money in or out", async () => {
    const user = userEvent.setup();
    const db0 = openDb("u1");
    await seedDefaults(db0);
    await db0.entries.add({
      id: "chk-payment",
      date: "2026-10-06",
      amount_cents: 120000,
      direction: "out",
      merchant: "PAYMENT TO CARD ••1173",
      clean_description: "PAYMENT TO CARD ••1173",
      raw_description: null,
      category_id: "cat-other",
      account_id: "acct-cash",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    await start();
    await user.upload(
      screen.getByLabelText(/Choose a statement file/),
      fileOf("card_oct.ofx", "application/x-ofx"),
    );
    await user.click(
      await screen.findByRole("button", { name: "+ New account: Rewards Bank ••1173 · Card" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Rewards Bank Card/ })).toBeChecked(),
    );
    await user.click(screen.getByRole("button", { name: "Read file" }));
    const card = await screen.findByRole("group", { name: "PAYMENT - THANK YOU: transfer?" });
    expect(within(card).getByRole("button", { name: "Yes, transfer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Import 2 transactions" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();

    const db = openDb("u1");
    const payment = (await db.entries.toArray()).find((e) => e.merchant === "PAYMENT - THANK YOU");
    expect(payment).toMatchObject({ is_transfer: true, transfer_pair_id: "chk-payment" });
    expect(await db.entries.get("chk-payment")).toMatchObject({
      is_transfer: true,
      category_id: null,
      transfer_pair_id: payment?.id,
    });
  });

  it("an import never offers a split part, a split parent, a pending row or an already paired row as the other side", async () => {
    installFakeApi({ session: readySession() });
    const base = {
      date: "2026-10-06",
      amount_cents: 120000,
      direction: "out" as const,
      merchant: "PAYMENT TO CARD",
      clean_description: "PAYMENT TO CARD",
      raw_description: null,
      category_id: "cat-other",
      account_id: "acct-cash",
      source: "manual" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    };
    const cases = {
      part: [
        { ...base, id: "parent", amount_cents: 5000 },
        { ...base, id: "part", split_parent_id: "parent" },
      ],
      parent: [
        { ...base, id: "parent" },
        { ...base, id: "part", amount_cents: 3000, split_parent_id: "parent" },
      ],
      pending: [{ ...base, id: "pending", pending: true }],
      paired: [{ ...base, id: "paired", transfer_pair_id: "elsewhere" }],
    };
    const row = {
      row: 1,
      date: "2026-10-07",
      description: "PAYMENT - THANK YOU",
      amount_cents: 120000,
      balance_cents: null,
    };
    for (const [name, entries] of Object.entries(cases)) {
      const db = openDb("u1");
      await db.entries.clear();
      await db.entries.bulkAdd(entries);
      const prepared = await prepareRows(db, "acct-card", [row]);
      expect({ name, match: prepared.rows[0]?.match ?? null }).toEqual({ name, match: null });
    }
    // The same row with a plain entry on the other side is offered
    const db = openDb("u1");
    await db.entries.clear();
    await db.entries.add({ ...base, id: "plain" });
    const prepared = await prepareRows(db, "acct-card", [row]);
    expect(prepared.rows[0]?.match?.entry_id).toBe("plain");
    // Marking by hand takes the same test, and never pairs from a part or a parent either
    const card = { ...base, account_id: "acct-card", direction: "in" as const };
    await db.entries.bulkAdd([
      { ...card, id: "card-parent", amount_cents: 5000 },
      { ...card, id: "card-part", split_parent_id: "card-parent" },
      { ...card, id: "card-whole", amount_cents: 120000, date: "2026-10-07" },
      { ...card, id: "card-whole-part", amount_cents: 100, split_parent_id: "card-whole" },
    ]);
    const part = await db.entries.get("card-part");
    const whole = await db.entries.get("card-whole");
    expect(part && (await findTransferPartner(db, part))).toBeNull();
    expect(whole && (await findTransferPartner(db, whole))).toBeNull();
    await db.entries.update("plain", { pending: true });
    await db.entries.delete("card-whole-part");
    expect(whole && (await findTransferPartner(db, whole))).toBeNull();
  });

  it("marking an entry a transfer by hand marks and pairs the matching other side", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const row = (
      id: string,
      direction: "in" | "out",
      account: string,
      date: string,
      cents = 50000,
    ) => ({
      id,
      date,
      amount_cents: cents,
      direction,
      merchant: id,
      clean_description: id,
      raw_description: null,
      category_id: null,
      account_id: account,
      source: "manual" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    await db.accounts.add({
      id: "acct-save",
      label: "Savings",
      type: "savings",
      last4: "4410",
      institution: null,
      currency: "USD",
      created_at: "2026-10-01T00:00:00Z",
    });
    await db.entries.bulkAdd([
      row("move-out", "out", "acct-cash", "2026-10-06"),
      row("move-in", "in", "acct-save", "2026-10-07"), // the other side, a day later
      row("same-acct", "in", "acct-cash", "2026-10-06"), // same account: never the pair
      row("too-late", "in", "acct-save", "2026-10-20"), // past the 5 days
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/entries/move-out");
    const transfer = await screen.findByRole("switch", { name: /Transfer between my accounts/ });
    await waitFor(() => expect(transfer).not.toBeChecked());
    await user.click(transfer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await db.entries.get("move-out")).toMatchObject({
        is_transfer: true,
        transfer_pair_id: "move-in",
      }),
    );
    expect(await db.entries.get("move-in")).toMatchObject({
      is_transfer: true,
      category_id: null,
      transfer_pair_id: "move-out",
    });
    expect(await db.entries.get("same-acct")).toMatchObject({ is_transfer: false });
    expect(await db.entries.get("too-late")).toMatchObject({ is_transfer: false });
  });

  it("marking a transfer with no other side recorded changes only that entry", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add({
      id: "alone",
      date: "2026-10-06",
      amount_cents: 7000,
      direction: "out",
      merchant: "To my other bank",
      clean_description: "To my other bank",
      raw_description: null,
      category_id: null,
      account_id: "acct-cash",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/entries/alone");
    const transfer = await screen.findByRole("switch", { name: /Transfer between my accounts/ });
    await waitFor(() => expect(transfer).not.toBeChecked());
    await user.click(transfer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await db.entries.get("alone")).toMatchObject({
        is_transfer: true,
        transfer_pair_id: null,
      }),
    );
    expect(await db.entries.count()).toBe(1);
  });

  it("unmarking one side of a transfer in the editor puts the other side back too", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const side = (id: string, pair: string, direction: "in" | "out", account: string) => ({
      id,
      date: "2026-10-06",
      amount_cents: 120000,
      direction,
      merchant: id,
      clean_description: id,
      raw_description: null,
      category_id: null,
      account_id: account,
      source: "manual" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: true,
      transfer_pair_id: pair,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    await db.accounts.add({
      id: "acct-card",
      label: "Card",
      type: "credit_card",
      last4: "1173",
      institution: null,
      currency: "USD",
      created_at: "2026-10-01T00:00:00Z",
    });
    await db.entries.bulkAdd([
      side("pay-out", "pay-in", "out", "acct-cash"),
      side("pay-in", "pay-out", "in", "acct-card"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/entries/pay-out");
    const transfer = await screen.findByRole("switch", { name: /Transfer between my accounts/ });
    await waitFor(() => expect(transfer).toBeChecked()); // the stored entry has loaded
    await user.click(transfer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await db.entries.get("pay-out")).toMatchObject({
        is_transfer: false,
        transfer_pair_id: null,
      }),
    );
    expect(await db.entries.get("pay-in")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
  });

  it("deleting one side of a transfer lets the other side count again", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.accounts.add({
      id: "acct-card",
      label: "Card",
      type: "credit_card",
      last4: "1173",
      institution: null,
      currency: "USD",
      created_at: "2026-10-01T00:00:00Z",
    });
    const side = (id: string, pair: string, direction: "in" | "out", account: string) => ({
      id,
      date: "2026-10-06",
      amount_cents: 120000,
      direction,
      merchant: id,
      clean_description: id,
      raw_description: null,
      category_id: null,
      account_id: account,
      source: "manual" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: true,
      transfer_pair_id: pair,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    });
    await db.entries.bulkAdd([
      side("del-out", "del-in", "out", "acct-cash"),
      side("del-in", "del-out", "in", "acct-card"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/entries/del-out");
    await screen.findByRole("heading", { level: 1, name: "Edit entry" });
    await user.click(await screen.findByRole("button", { name: "Delete entry" }));
    await user.click(await screen.findByRole("button", { name: "Really delete this entry" }));
    await waitFor(async () => expect(await db.entries.get("del-out")).toBeUndefined());
    expect(await db.entries.get("del-in")).toMatchObject({
      is_transfer: false,
      transfer_pair_id: null,
    });
  });

  it("the + button offers an entry, a statement, and (later) a receipt", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Add entry or receipt" }));
    const sheet = await screen.findByRole("dialog", { name: "What do you want to add?" });
    expect(within(sheet).getByText("A photo, kept on this device")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: /A statement/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Import a statement" }),
    ).toBeInTheDocument();
  });
});

vi.mock("../../src/importers/pdf/extract.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/importers/pdf/extract.ts")>();
  return {
    ...mod,
    // jsdom has no pdf.js runtime; the node test proves extraction on a real PDF
    extractLines: vi.fn(async () => [
      "First Example Bank",
      "Everyday Checking Account number ****4821",
      "Statement period 09/10/2026 - 10/09/2026",
      "Date Description Amount Balance",
      "09/12 DIRECT DEPOSIT ACME PAYROLL 2,600.00 3,814.22",
      "09/14 CORNER MKT #214 1234567890124821 -54.10 3,760.12",
      "10/02 CHECK 1041 -300.00 3,460.12",
      "Ending balance 3,460.12",
    ]),
  };
});

describe("PDF statement (fast-follow 2)", () => {
  it("reads a PDF on the device, skips column matching, imports with the template recorded; nothing is uploaded", async () => {
    const user = userEvent.setup();
    const fake = await start();
    await user.upload(
      screen.getByLabelText(/Choose a statement file/),
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "october.pdf", {
        type: "application/pdf",
      }),
    );
    expect(await screen.findByText("october.pdf · 3 rows")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Cash/ }));
    await user.click(screen.getByRole("button", { name: "Read file" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Review import" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Match columns" })).toBeNull();
    // The PDF's own check, said before anything is imported (October 22, 2026).
    expect(
      screen.getByText("Read from a PDF. The rows add up to your statement's ending balance."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Import 3/ }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });

    const db = openDb("u1");
    const entries = await db.entries.toArray();
    expect(entries.map((e) => [e.date, e.merchant, e.direction, e.amount_cents]).sort()).toEqual([
      ["2026-09-12", "DIRECT DEPOSIT ACME PAYROLL", "in", 260000],
      ["2026-09-14", "CORNER MKT #••4821", "out", 5410],
      ["2026-10-02", "CHECK 1041", "out", 30000],
    ]);
    expect(await db.statement_imports.toArray()).toMatchObject([
      {
        format: "pdf",
        template_key: "generic_lines",
        rows_added: 3,
        period_start: "2026-09-10",
        period_end: "2026-10-09",
        ending_balance_cents: 346012,
      },
    ]);
    expect((await db.accounts.get("acct-cash"))?.last4).toBe("4821");
    expect(onlySessionReads(fake.calls)).toEqual([]);
  });
});
