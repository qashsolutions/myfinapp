/**
 * The network sweep (docs/spec.md chunk 1.15: "network tests prove statements, receipts and
 * transactions never leave the device unencrypted"). Distinctive values go into every kind of
 * money data, the flows that talk to the server run, and then every request the fake server
 * saw is searched for them. The only bodies allowed to carry anything derived from money data
 * are the backup and household blobs, and those must be ciphertext.
 */

import { readFileSync } from "node:fs";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { enableBackup, pushBackup } from "../../src/data/backup/sync.ts";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { collectExport } from "../../src/data/export.ts";
import { storeReceiptPhoto } from "../../src/data/receipts.ts";
import { parseAmount } from "../../src/engine/bridge.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import { addGoalEvent, createGoal } from "../../src/features/goals/useGoals.ts";
import { saveHelped } from "../../src/features/groups/WhatHelped.tsx";
import { publishHousehold } from "../../src/features/household/householdSync.ts";
import { commitImport, parseFile, prepareRows } from "../../src/features/imports/importFlow.ts";
import {
  attachAccounts,
  disconnect,
  finishLink,
  isFailure,
} from "../../src/features/linking/linking.ts";
import { syncConnection } from "../../src/features/linking/sync.ts";
import { applyMapping, guessMapping } from "../../src/importers/csv.ts";
import { type FakeApi, fakeMember, installFakeApi, mayasGroup, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");
const MERCHANT = "Zebra Cafe 9Q";
const CENTS = 123457; // $1,234.57
const LAST4 = "4821";
const RAW = "POS DEBIT ZEBRA CAFE 9Q 1234567890124821";
const SENTINELS = [
  MERCHANT,
  String(CENTS),
  "1234.57",
  "1,234.57",
  RAW,
  "1234567890124821",
  "ZEBRA",
  "LINKED SWEEP MERCHANT", // arrives in a sync answer; must never go back out
  "4321",
  "Kiwi note 7Z", // an entry's note (October 19, 2026)
  "Tahiti 7Z", // an entry's tag
  "Yacht 7Z", // a hand-added net worth item
];

function entry(id: string, merchant: string, cents: number): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: cents,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: RAW,
    category_id: "cat-shopping",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
  };
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** A URL as written and as decoded (`%20` and `+` both read as a space). */
function urlText(url: string): string {
  try {
    return `${url} ${decodeURIComponent(url.replace(/\+/g, " "))}`;
  } catch {
    return url;
  }
}

/** Everything a request carried: the whole URL with its query, every header, the raw body. */
function sweep(api: Pick<FakeApi, "calls">) {
  const leaks: string[] = [];
  for (const call of api.calls) {
    const text = [
      urlText(call.url),
      JSON.stringify(call.headers),
      call.raw,
      JSON.stringify(call.body ?? {}),
    ].join(" ");
    const isBlob =
      call.path === "/api/backup/blob" || call.path.startsWith("/api/household/blobs/");
    if (isBlob) {
      const body = call.body as { ciphertext?: string } | undefined;
      expect(body?.ciphertext, `${call.path} must carry base64url ciphertext`).toMatch(B64URL);
    }
    for (const s of SENTINELS)
      if (text.includes(s)) leaks.push(`${call.method} ${call.path}: ${s}`);
    if (
      /amount_cents|merchant|raw_description|account_number|balance_cents/i.test(
        `${urlText(call.url)} ${JSON.stringify(call.headers)} ${call.raw}`,
      )
    )
      leaks.push(`${call.method} ${call.path}: a money field name`);
  }
  return leaks;
}

describe("the sweep itself", () => {
  it("reports a value in a query string, in a header or in a body that is not JSON", () => {
    const call = (over: Partial<FakeApi["calls"][number]>): FakeApi["calls"][number] => ({
      method: "GET",
      path: "/api/groups",
      url: "http://localhost/api/groups",
      headers: {},
      raw: "",
      ...over,
    });
    const leaks = sweep({
      calls: [
        call({ url: `http://localhost/api/groups?q=${encodeURIComponent(MERCHANT)}` }),
        call({ path: "/api/linking", headers: { "x-note": "Kiwi note 7Z" } }),
        call({ method: "POST", path: "/api/alerts/schedule", raw: `merchant=${RAW}` }),
      ],
    });
    expect(leaks).toEqual([
      `GET /api/groups: ${MERCHANT}`,
      "GET /api/linking: Kiwi note 7Z",
      `POST /api/alerts/schedule: ${RAW}`,
      "POST /api/alerts/schedule: 1234567890124821",
      "POST /api/alerts/schedule: ZEBRA",
      "POST /api/alerts/schedule: a money field name",
    ]);
  });
});

describe("nothing about money leaves the device unencrypted", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("across entries, a statement import, a receipt, jars, a challenge, the backup, the household, alerts and export", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession({
        user: { id: "u1", email: "maya@example.com", display_name: "Maya R.", look: "modern" },
      }),
      billing: { ...(await import("../fakeApi.ts")).privateBilling(), plan: "connected" },
      groups: [
        mayasGroup(),
        {
          ...mayasGroup(),
          id: "g-sweep",
          invite_code: "STK-SWP1",
          members: [fakeMember("u1", "Maya R.", 10000), fakeMember("u-dev", "Dev P.", 6400)],
        },
      ],
      households: {
        rows: [
          {
            id: "hh-test",
            owner_id: "u1",
            created_at: "2026-10-01T00:00:00Z",
            members: [
              {
                user_id: "u1",
                display_name: "Maya R.",
                initial: "M",
                joined_at: "2026-10-01T00:00:00Z",
                left_at: null,
              },
              {
                user_id: "u2",
                display_name: "Dev P.",
                initial: "D",
                joined_at: "2026-10-02T00:00:00Z",
                left_at: null,
              },
            ],
            invite: null,
            blobs: [],
          },
        ],
        seq: 1,
      },
    });
    const db = openDb("u1");
    await seedDefaults(db);

    // 1. Entries by hand, with a distinctive merchant and amount
    await db.entries.add({
      ...entry("e1", MERCHANT, CENTS),
      note: "Kiwi note 7Z",
      tags: ["Tahiti 7Z"],
    });
    await db.net_worth_items.add({
      id: "nw1",
      kind: "asset",
      group: "vehicle",
      label: "Yacht 7Z",
      value_cents: 4_200_000,
      source: "manual",
      ref_id: null,
      included: true,
      created_at: "2026-10-10T00:00:00.000Z",
      updated_at: "2026-10-10T00:00:00.000Z",
    });

    // 1b. A zero-based plan the entry runs past: the budget alert goes on the schedule
    await createBudget(db, "2026-10", "zero_based", 500000, [
      { category_id: "cat-shopping", planned_cents: 100000 },
    ]);

    // 2. A statement import, on the device
    const csv = readFileSync(`${process.cwd()}/tests/fixtures/statement_oct.csv`, "utf8").replace(
      /Corner M[a-z]+ #214/gi,
      MERCHANT,
    );
    const account = (await db.accounts.toArray())[0];
    if (!account) throw new Error("no account");
    await db.accounts.update(account.id, { last4: LAST4 });
    const parsed = await parseFile("statement.csv", csv);
    if (parsed.format !== "csv" || !parsed.csv) throw new Error("expected csv");
    const mapping = guessMapping(parsed.csv);
    const { rows } = await applyMapping(parsed.csv, mapping, parseAmount);
    const prepared = await prepareRows(db, account.id, rows);
    await commitImport(db, {
      account,
      format: "csv",
      fileName: "statement.csv",
      prepared,
      transfers: new Set(),
      mapping,
      rememberMapping: true,
      file: new File([csv], "statement.csv", { type: "text/csv" }),
      keepFile: true,
    });

    // 3. A receipt photo, stored on the device
    await storeReceiptPhoto(
      db,
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "r.jpg", { type: "image/jpeg" }),
      "90d",
      "2026-10-10",
    ).catch(() => null);

    // 4. A jar with a deposit, and the challenge jar for the group
    const jar = await createGoal(db, {
      kind: "save",
      title: MERCHANT.slice(0, 10),
      target_cents: CENTS,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      household_id: "hh-test",
    });
    await addGoalEvent(db, jar.id, "deposit", "2026-10-06", CENTS, new Date(), "u1");
    await db.settings.bulkPut([
      { key: "household.id", value: "hh-test", updated_at: "x" },
      { key: "household.key", value: "a".repeat(43), updated_at: "x" },
      { key: "household.share_summary", value: true, updated_at: "x" },
    ]);

    // 5. The screens that talk to the server while showing money
    renderApp("/");
    await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await user.click(screen.getByRole("link", { name: "Goals" }));
    await screen.findByRole("heading", { level: 1, name: "Goals" });
    await user.click(screen.getByRole("radio", { name: "Challenges" }));
    await screen.findByText(/Join with a code/);

    // 5b. "What helped" in a challenge: choice ids only
    await saveHelped("g-sweep", ["packed_lunch", "cooked_home"]);

    // 6. The backup and the household publish (the shell registered the alert schedule above)
    await enableBackup(db, "u1", null);
    await pushBackup(db, "u1", "test", { force: true });
    await publishHousehold(db, "u1", "2026-10-10");

    // 6b. Linking (Phase 3): the device sends a session id, a connection id and a cursor, nothing
    // else; the synced rows (answers, not requests) carry merchant text into this device only
    api.linking.sessions.push("ls-sweep");
    api.linking.nextLink = [
      {
        institution_name: "First Platypus Bank",
        accounts: [
          {
            account_id: "acc-chk",
            name: "Plaid Checking",
            mask: "0000",
            type: "depository",
            subtype: "checking",
          },
        ],
      },
    ];
    const linked = await finishLink("ls-sweep");
    if (!isFailure(linked)) {
      await attachAccounts(db, linked.connections);
      for (const c of linked.connections) {
        api.linking.syncPages[c.id] = [
          {
            added: [
              {
                transaction_id: "sweep-1",
                account_id: "acc-chk",
                date: "2026-10-09",
                direction: "out",
                amount_cents: 4321,
                description: "LINKED SWEEP MERCHANT",
                pending: false,
                pending_transaction_id: null,
              },
            ],
          },
        ];
        await syncConnection(db, c.id);
        expect(await db.entries.get("lnk-sweep-1")).toBeTruthy();
        await pushBackup(db, "u1", "test", { force: true }); // the synced row leaves only as ciphertext
        await disconnect(db, c.id);
      }
    }

    // 7. Export: the one request adds server-held data; the money stays here
    expect((await collectExport(db, null, TODAY.toISOString())).length).toBeGreaterThan(3);

    await waitFor(
      () => {
        const seen = new Set(api.calls.map((c) => c.path));
        for (const must of [
          "/api/backup/blob",
          "/api/household/blobs/jars",
          "/api/household/blobs/summary",
          "/api/alerts/schedule",
          "/api/groups",
          "/api/groups/g-sweep/helped",
          "/api/linking/finish",
          "/api/linking/bc1/sync",
        ])
          expect([...seen], `the sweep never exercised ${must}`).toContain(must);
        // The budget alert went on the schedule too (as a month, a tag and a level only)
        expect(
          api.calls.some(
            (c) =>
              c.path === "/api/alerts/schedule" && JSON.stringify(c.body).includes("budget_pace"),
          ),
          "the sweep never scheduled a budget alert",
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    expect(sweep(api)).toEqual([]);
    expect(api.calls.length).toBeGreaterThan(8);
  });
});
