/**
 * Your documents (owner decision, November 16, 2026): every file added, numbered, newest first,
 * with the date the document gives, the day it was added and what it became; names masked.
 */

import { screen, within } from "@testing-library/react";
import { buildSnapshot } from "../../src/data/backup/snapshot.ts";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { collectExport } from "../../src/data/export.ts";
import { saveFromDocument } from "../../src/features/networth/useNetWorth.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-11-16T12:00:00");

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.add({
    id: "acct-chk",
    label: "Everyday checking",
    type: "checking",
    last4: "4821",
    institution: null,
    currency: "USD",
    created_at: "2026-10-01T00:00:00Z",
  });
  await db.statement_imports.add({
    id: "imp-1",
    account_id: "acct-chk",
    format: "pdf",
    template_key: "generic_lines",
    file_name: "Checking_123456789_Oct.pdf",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    ending_balance_cents: 100000,
    rows_found: 42,
    rows_added: 42,
    rows_skipped: 0,
    file_key: null,
    status: "done",
    created_at: "2026-11-15T09:00:00.000Z",
  });
  await saveFromDocument(db, {
    kind: "asset",
    group: "retirement",
    label: "Rollover IRA",
    value_cents: 4821055,
    as_of: "2026-09-03",
    file_name: "Positions_250044484.pdf",
  });
  return db;
}

describe("Your documents", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    installFakeApi({ session: readySession() });
  });
  afterEach(() => vi.useRealTimers());

  it("lists every file, numbered, newest first, with its dates and what it became", async () => {
    await seed();
    renderApp("/me/documents");
    const list = await screen.findByRole("list", { name: "Files added" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      // Added today, so first; 74 days past its date, so it asks for a newer one.
      "1Positions_••4484.pdfSep 3, 2026 · added Nov 16Net worth · Rollover IRA · $48,210.55 · Retirement74 days old · Update with a newer one",
      "2Checking_••6789_Oct.pdfOct 1, 2026 – Oct 31, 2026 · added Nov 15Everyday checking ••4821 · 42 transactions",
    ]);
    expect(
      within(rows[0] as HTMLElement).getByRole("link", { name: /Update with a newer one/ }),
    ).toHaveAttribute("href", "/import");
  });

  it("keeps the masked name only, syncs it in the backup and puts it in the export", async () => {
    const db = await seed();
    const kept = await db.document_imports.toArray();
    expect(kept).toMatchObject([{ file_name: "Positions_••4484.pdf", label: "Rollover IRA" }]);
    expect(JSON.stringify(kept)).not.toMatch(/250044484/);
    const snapshot = await buildSnapshot(db, { rulesVersion: "test", deviceId: "d1" });
    expect(snapshot.tables.document_imports).toHaveLength(1);
    const files = await collectExport(db, null, "2026-11-16T12:00:00Z");
    const text = files.map((f) => new TextDecoder().decode(f.data)).join(" ");
    expect(text).toMatch(/Positions_••4484\.pdf/);
  });

  it("says how to start when nothing was added", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    renderApp("/me/documents");
    expect(
      await screen.findByText(/Statements and documents you add show here/),
    ).toBeInTheDocument();
  });
});
