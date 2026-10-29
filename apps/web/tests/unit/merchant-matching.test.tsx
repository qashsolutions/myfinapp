/**
 * Defect round 2 (October 29, 2026), invariants 47-50: one merchant, one key on the bank's own
 * text (a rename never disconnects a bill), an upload never duplicates a linked row, pay twice a
 * month is twice a month and a bill keeps its day of the month, and a keyword is a whole word
 * with the longest one winning.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type Account,
  type Entry,
  openDb,
  type StackdDb,
  seedDefaults,
} from "../../src/data/db.ts";
import { DEFAULT_CATEGORIES } from "../../src/data/defaults.ts";
import { detectRecurring, merchantKey, upcomingItems } from "../../src/engine/bridge.ts";
import { likeThis, renameEntry } from "../../src/features/entries/entryActions.ts";
import {
  backfillSeriesDays,
  confirmSuggestion,
  removeSeries,
  seriesInput,
  toRecurringEntry,
} from "../../src/features/forecast/useRecurring.ts";
import { commitImport, prepareRows } from "../../src/features/imports/importFlow.ts";
import { applySync, type SyncOut } from "../../src/features/linking/sync.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const CHECKING: Account = {
  id: "acct-chk",
  label: "Checking",
  type: "checking",
  last4: "0000",
  institution: "First Platypus Bank",
  currency: "USD",
  created_at: "2026-09-01T00:00:00Z",
  linked: { connection_id: "bc1", account_id: "acc-chk" },
};

function entry(id: string, date: string, cents: number, text: string, over: Partial<Entry> = {}) {
  const row: Entry = {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant: text,
    clean_description: text.toUpperCase(),
    raw_description: text,
    category_id: null,
    account_id: "acct-chk",
    source: "import",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
    ...over,
  };
  return row;
}

async function seed(): Promise<StackdDb> {
  const db = openDb("u1");
  await db.categories.bulkPut(DEFAULT_CATEGORIES);
  await db.accounts.bulkPut([CHECKING]);
  return db;
}

async function suggestionsOf(db: StackdDb, asOf: string) {
  const all = await db.entries.toArray();
  return (await detectRecurring(all.map(toRecurringEntry), asOf)).map((s) => ({
    ...s,
    label: s.payee,
  }));
}

describe("one merchant, one key (invariant 47)", () => {
  it("NETFLIX, netflix, Netflix.com, NETFLIX.COM and www.netflix.com are one merchant", async () => {
    const keys = await Promise.all(
      ["NETFLIX", "netflix", "Netflix.com", "NETFLIX.COM", "www.netflix.com"].map(merchantKey),
    );
    expect(new Set(keys)).toEqual(new Set(["NETFLIX"]));
  });

  it("renaming a bill's charges keeps them on the bill: matched, still recurring, removable", async () => {
    const db = await seed();
    await db.entries.bulkAdd([
      entry("n1", "2026-08-14", 1549, "NETFLIX.COM"),
      entry("n2", "2026-09-14", 1549, "NETFLIX.COM"),
      entry("n3", "2026-10-14", 1549, "NETFLIX.COM"),
    ]);
    const [found] = await suggestionsOf(db, "2026-10-20");
    expect(found).toMatchObject({ payee: "NETFLIX", interval: "monthly", day: 14 });
    const bill = await confirmSuggestion(db, found as NonNullable<typeof found>);

    // The person names them their own way, every one like it.
    await renameEntry(db, (await db.entries.get("n1")) as Entry, "My shows", true);
    await db.entries.add(entry("n4", "2026-11-14", 1549, "NETFLIX.COM", { merchant: "My shows" }));
    const rows = await db.entries.toArray();
    expect(rows.every((e) => e.merchant === "My shows")).toBe(true);
    expect(rows.map(toRecurringEntry).map((r) => r.payee)).toEqual(rows.map(() => "NETFLIX.COM"));

    // The next charge is matched as paid, so it is not taken off the balance a second time.
    const up = await upcomingItems(
      [seriesInput(bill)],
      rows.map(toRecurringEntry),
      "2026-11-10",
      30,
    );
    expect(up.items).toEqual([expect.objectContaining({ date: "2026-11-14", matched: true })]);
    // Removing the bill clears the renamed charges' recurring mark.
    await removeSeries(db, bill.id);
    expect((await db.entries.toArray()).filter((e) => e.is_recurring)).toEqual([]);
  });

  it("rename all like this and a saved name reach every spelling of the merchant", async () => {
    const db = await seed();
    await db.entries.bulkAdd([
      entry("a", "2026-10-01", 1549, "NETFLIX.COM"),
      entry("b", "2026-10-02", 1549, "Netflix"),
      entry("c", "2026-10-03", 900, "HULU"),
    ]);
    expect((await likeThis(db, (await db.entries.get("a")) as Entry)).map((e) => e.id)).toEqual([
      "b",
    ]);
    await renameEntry(db, (await db.entries.get("a")) as Entry, "Movies", true);
    expect((await db.entries.get("b"))?.merchant).toBe("Movies");
    // The next statement says "www.netflix.com": the saved name is used.
    const prepared = await prepareRows(db, "acct-chk", [
      {
        row: 1,
        date: "2026-11-01",
        description: "www.netflix.com",
        amount_cents: -1549,
        balance_cents: null,
      },
    ]);
    await commitImport(db, {
      account: CHECKING,
      format: "csv",
      fileName: "nov.csv",
      prepared,
      transfers: new Set(),
    });
    const imported = (await db.entries.toArray()).find((e) => e.date === "2026-11-01");
    expect(imported?.merchant).toBe("Movies");
  });
});

function page(over: Partial<SyncOut> = {}): SyncOut {
  return {
    added: [],
    modified: [],
    removed: [],
    balances: [],
    next_cursor: "cur-1",
    has_more: false,
    ...over,
  };
}

const SYNCED = {
  transaction_id: "t1",
  account_id: "acc-chk",
  date: "2026-10-10",
  direction: "out" as const,
  amount_cents: 645,
  description: "Starbucks",
  pending: false,
  pending_transaction_id: null,
};

describe("an upload never duplicates a linked row (invariant 48)", () => {
  it("synced first, then the statement: the same day, amount and direction is skipped", async () => {
    const db = await seed();
    await applySync(db, "bc1", page({ added: [SYNCED] }), new Date("2026-10-12T15:00:00Z"));
    const prepared = await prepareRows(db, "acct-chk", [
      // The bank's statement text differs from the name the sync gave, so the fingerprints differ.
      {
        row: 1,
        date: "2026-10-10",
        description: "STARBUCKS STORE 1234",
        amount_cents: -645,
        balance_cents: null,
      },
      // One synced row pairs with one file row: a second coffee that day is new.
      {
        row: 2,
        date: "2026-10-10",
        description: "STARBUCKS STORE 1234",
        amount_cents: -645,
        balance_cents: null,
      },
      {
        row: 3,
        date: "2026-10-11",
        description: "CORNER MKT",
        amount_cents: -1200,
        balance_cents: null,
      },
    ]);
    expect(prepared.rows.map((r) => r.duplicate)).toEqual([true, false, false]);
    expect(prepared).toMatchObject({ found: 3, fresh: 2, duplicates: 1 });
    await commitImport(db, {
      account: CHECKING,
      format: "csv",
      fileName: "oct.csv",
      prepared,
      transfers: new Set(),
    });
    const coffee = (await db.entries.toArray()).filter((e) => e.amount_cents === 645);
    expect(coffee).toHaveLength(2);
  });

  it("the statement first, then the sync: the sync adopts it, still one entry", async () => {
    const db = await seed();
    const prepared = await prepareRows(db, "acct-chk", [
      {
        row: 1,
        date: "2026-10-10",
        description: "STARBUCKS STORE 1234",
        amount_cents: -645,
        balance_cents: null,
      },
    ]);
    await commitImport(db, {
      account: CHECKING,
      format: "csv",
      fileName: "oct.csv",
      prepared,
      transfers: new Set(),
    });
    const report = await applySync(
      db,
      "bc1",
      page({ added: [SYNCED] }),
      new Date("2026-10-12T15:00:00Z"),
    );
    expect(report).toMatchObject({ added: 0, adopted: 1 });
    expect(await db.entries.count()).toBe(1);
  });
});

describe("pay and bills on their days (invariant 49)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pay on the 15th and the last day becomes twice-a-month pay: $5,000 a month, not $5,416.67", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const days = [
      "2026-09-15",
      "2026-09-30",
      "2026-10-15",
      "2026-10-30",
      "2026-11-13",
      "2026-11-30",
    ];
    await db.entries.bulkAdd(
      days.map((d, i) =>
        entry(`p${i}`, d, 250000, "ACME PAYROLL", {
          direction: "in",
          account_id: "acct-cash",
          category_id: "cat-paycheck",
        }),
      ),
    );
    installFakeApi({ session: readySession() });
    renderApp("/");
    const found = await screen.findByRole("region", { name: "Your paycheck, spotted" });
    await user.click(
      within(found).getByRole("button", { name: "Use $2,500.00 twice a month as my pay" }),
    );
    await waitFor(async () =>
      expect((await db.settings.get("pay"))?.value).toMatchObject({
        amount_cents: 250000,
        frequency: "semimonthly",
        days: [15, 31],
        next_payday: "2026-12-15",
        monthly_cents: 500000,
      }),
    );
  });

  it("a twice-a-month bill is confirmed as one monthly bill per day", async () => {
    const db = await seed();
    const days = [
      "2026-09-15",
      "2026-09-30",
      "2026-10-15",
      "2026-10-30",
      "2026-11-13",
      "2026-11-30",
    ];
    await db.entries.bulkAdd(days.map((d, i) => entry(`c${i}`, d, 30000, "SITTER CO")));
    const [found] = await suggestionsOf(db, "2026-12-01");
    expect(found).toMatchObject({ interval: "semimonthly", days: [15, 31] });
    await confirmSuggestion(db, found as NonNullable<typeof found>);
    const rows = (await db.recurring_series.toArray()).sort((a, b) => (a.day ?? 0) - (b.day ?? 0));
    expect(rows.map((r) => [r.interval, r.day, r.next_date])).toEqual([
      ["monthly", 15, "2026-12-15"],
      ["monthly", 31, "2026-12-31"],
    ]);
  });

  it("rent on the 30th, 31st and 31st stays on the last day: Feb 28, Mar 31, Apr 30", async () => {
    const db = await seed();
    await db.entries.bulkAdd([
      entry("r1", "2026-11-30", 150000, "RENT CO"),
      entry("r2", "2026-12-31", 150000, "RENT CO"),
      entry("r3", "2027-01-31", 150000, "RENT CO"),
    ]);
    const [found] = await suggestionsOf(db, "2027-02-10");
    const bill = await confirmSuggestion(db, found as NonNullable<typeof found>);
    expect(bill).toMatchObject({ day: 31, next_date: "2027-02-28" });
    const up = await upcomingItems([seriesInput(bill)], [], "2027-02-10", 90);
    expect(up.items.map((i) => i.date)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
  });
});

describe("a bill confirmed before it kept its day (invariant 49)", () => {
  it("reads its day once from its own charges and leaves the 28th it drifted to", async () => {
    const db = await seed();
    await db.entries.bulkAdd([
      entry("r1", "2026-11-30", 150000, "RENT CO", { is_recurring: true }),
      entry("r2", "2026-12-31", 150000, "RENT CO", { is_recurring: true }),
      entry("r3", "2027-01-31", 150000, "RENT CO", { is_recurring: true }),
      entry("r4", "2027-02-28", 150000, "RENT CO", { is_recurring: true }),
    ]);
    // Confirmed before series kept a day: stepped from Feb 28 it had drifted to Mar 28.
    await db.recurring_series.add({
      id: "old-rent",
      payee: "RENT CO",
      label: "Rent",
      kind: "bill",
      expected_cents: 150000,
      interval: "monthly",
      next_date: "2027-03-28",
      status: "confirmed",
      source: "detected",
      account_id: null,
      created_at: "2026-12-01T00:00:00Z",
      updated_at: "2026-12-01T00:00:00Z",
    });
    const before = await db.recurring_series.toArray();
    const [fixed] = await backfillSeriesDays(db, before, await db.entries.toArray(), "2027-03-10");
    expect(fixed).toMatchObject({ day: 31, next_date: "2027-03-31" });
    expect(await db.recurring_series.get("old-rent")).toMatchObject({
      day: 31,
      next_date: "2027-03-31",
    });
    const up = await upcomingItems(
      [seriesInput(fixed as NonNullable<typeof fixed>)],
      [],
      "2027-03-10",
      60,
    );
    expect(up.items.map((i) => i.date)).toEqual(["2027-03-31", "2027-04-30"]);
    // Stored once: a second pass changes nothing.
    const stamp = (await db.recurring_series.get("old-rent"))?.updated_at;
    await backfillSeriesDays(
      db,
      await db.recurring_series.toArray(),
      await db.entries.toArray(),
      "2027-03-10",
    );
    expect((await db.recurring_series.get("old-rent"))?.updated_at).toBe(stamp);
  });
});

describe("a keyword is a whole word and the longest wins (invariant 50)", () => {
  it("an import sorts UBER EATS as dining, a rental car as transport, SHELLS SEAFOOD as dining", async () => {
    const db = await seed();
    const prepared = await prepareRows(db, "acct-chk", [
      {
        row: 1,
        date: "2026-10-01",
        description: "UBER EATS PENDING",
        amount_cents: -2350,
        balance_cents: null,
      },
      {
        row: 2,
        date: "2026-10-02",
        description: "UBER *EATS",
        amount_cents: -1810,
        balance_cents: null,
      },
      {
        row: 3,
        date: "2026-10-03",
        description: "ENTERPRISE RENT-A-CAR #123",
        amount_cents: -9000,
        balance_cents: null,
      },
      {
        row: 4,
        date: "2026-10-04",
        description: "SHELLS SEAFOOD RESTAURANT",
        amount_cents: -4400,
        balance_cents: null,
      },
      {
        row: 5,
        date: "2026-10-05",
        description: "UBER TRIP",
        amount_cents: -1500,
        balance_cents: null,
      },
    ]);
    expect(prepared.rows.map((r) => r.category_id)).toEqual([
      "cat-dining",
      "cat-dining",
      "cat-transport",
      "cat-dining",
      "cat-transport",
    ]);
  });
});
