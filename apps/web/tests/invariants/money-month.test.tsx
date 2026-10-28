/**
 * One realistic month through the real code paths, checked against totals worked out by hand
 * (docs/invariants.md). Each feature has its own tests; this one catches two features that each
 * work and break together: a bank sync and a split, an import and a transfer, Move money and
 * Home, Don't count and every total.
 *
 * The month (today is October 20, 2026):
 *   Checking, linked:  paycheck +$3,000 · rent −$1,200 · card payment −$500 (a transfer)
 *                      coffee −$20 pending, split $5 to Dining, posts at −$22 with the tip
 *   Card, a statement: groceries −$150 · dining −$60 · office supplies −$40 (Don't count)
 *                      payment received +$500 (the other side of the transfer)
 *   Jars:              $300 into the Emergency fund, then $100 moved to Trip
 *
 * By hand: Got $3,000 · Spent $1,200 + $22 + $150 + $60 = $1,432 · Kept $1,568.
 * Set aside $300 (a move is not new money). The Emergency fund holds $200, Trip $100.
 * The recap's week (Oct 14–20): the coffee only, $22; no new money into jars.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type Account,
  type Entry,
  openDb,
  type StackdDb,
  seedDefaults,
} from "../../src/data/db.ts";
import { parseAmount } from "../../src/engine/bridge.ts";
import { setCounted } from "../../src/features/entries/entryActions.ts";
import { addGoalEvent, moveMoney } from "../../src/features/goals/useGoals.ts";
import { commitImport, parseFile, prepareRows } from "../../src/features/imports/importFlow.ts";
import { applySync, type SyncOut, type SyncTxn } from "../../src/features/linking/sync.ts";
import { applyMapping, guessMapping } from "../../src/importers/csv.ts";
import { emptyLinking, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-20T12:00:00");

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
const CARD: Account = {
  id: "acct-cc",
  label: "Card",
  type: "credit_card",
  last4: "3333",
  institution: "Rewards Bank",
  currency: "USD",
  created_at: "2026-09-01T00:00:00Z",
};

const CARD_CSV = [
  "Date,Description,Amount",
  "2026-10-05,WHOLE FOODS MARKET,-150.00",
  "2026-10-11,PAYMENT - THANK YOU,500.00",
  "2026-10-12,CHIPOTLE 0423,-60.00",
  "2026-10-14,OFFICE DEPOT 2231,-40.00",
].join("\n");

function txn(over: Partial<SyncTxn>): SyncTxn {
  return {
    transaction_id: "t",
    account_id: "acc-chk",
    date: "2026-10-01",
    direction: "out",
    amount_cents: 0,
    description: "",
    pending: false,
    pending_transaction_id: null,
    ...over,
  };
}

function page(over: Partial<SyncOut>): SyncOut {
  return {
    added: [],
    modified: [],
    removed: [],
    balances: [],
    next_cursor: "cur",
    has_more: false,
    ...over,
  };
}

const NOW = new Date("2026-10-20T15:00:00Z");

/** The server, which still lists the bank connection (else the app unlinks Checking). */
function server() {
  installFakeApi({
    session: readySession(),
    linking: {
      ...emptyLinking(),
      connections: [
        {
          id: "bc1",
          institution_name: "First Platypus Bank",
          created_at: "2026-09-01T00:00:00Z",
          status: "active",
          updates_available: false,
          last_synced_at: NOW.toISOString(),
        },
      ],
    },
  });
}

async function jar(db: StackdDb, id: string, title: string, target: number) {
  await db.goals.add({
    id,
    kind: "save",
    title,
    target_cents: target,
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
}

/** The month up to the split; `posted` runs the bank's posting of the coffee after it. */
async function theMonth(): Promise<StackdDb> {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.bulkPut([CHECKING, CARD]);
  await db.settings.put({
    key: "pay",
    value: {
      amount_cents: 240000,
      frequency: "biweekly",
      next_payday: "2026-10-23",
      monthly_cents: 520000,
    },
    updated_at: "2026-10-01T00:00:00Z",
  });
  await db.budgets.add({
    id: "b-oct",
    month: "2026-10",
    method: "50_30_20",
    take_home_cents: 520000,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });

  // The bank
  await applySync(
    db,
    "bc1",
    page({
      added: [
        txn({
          transaction_id: "t-pay",
          direction: "in",
          amount_cents: 300000,
          description: "ACME PAYROLL",
        }),
        txn({
          transaction_id: "t-rent",
          date: "2026-10-02",
          amount_cents: 120000,
          description: "OAK STREET RENT",
        }),
        txn({
          transaction_id: "t-ccpay",
          date: "2026-10-10",
          amount_cents: 50000,
          description: "PAYMENT TO CARD 3333",
        }),
        txn({
          transaction_id: "p-coffee",
          date: "2026-10-15",
          amount_cents: 2000,
          description: "BLUE BOTTLE COFFEE",
          pending: true,
        }),
      ],
      balances: [{ account_id: "acc-chk", current_cents: 500000, type: "depository" }],
    }),
    NOW,
  );

  // The card's statement: the payment received matches the checking payment, and is confirmed
  const parsed = await parseFile("card_oct.csv", CARD_CSV);
  const table = parsed.csv as NonNullable<typeof parsed.csv>;
  const mapping = guessMapping(table);
  const { rows } = await applyMapping(table, mapping, parseAmount);
  const prepared = await prepareRows(db, CARD.id, rows);
  const matched = prepared.rows.filter((r) => r.match);
  expect(matched.map((r) => r.description)).toEqual(["PAYMENT - THANK YOU"]);
  await commitImport(db, {
    account: CARD,
    format: "csv",
    fileName: "card_oct.csv",
    prepared,
    transfers: new Set(matched.map((r) => r.fingerprint)),
    mapping,
  });

  // Office supplies are reimbursed by work: Don't count
  const office = (await db.entries.toArray()).find((e) => e.merchant.startsWith("OFFICE DEPOT"));
  await setCounted(db, (office as Entry).id, false);

  // Jars
  await jar(db, "jar-ef", "Emergency fund", 100000);
  await jar(db, "jar-trip", "Trip", 200000);
  await addGoalEvent(db, "jar-ef", "deposit", "2026-10-03", 30000);
  await moveMoney(db, "jar-ef", "jar-trip", 10000, "2026-10-16");
  return db;
}

/** Split $5 off the pending coffee in the entry editor, as a person would. */
async function splitCoffee() {
  const user = userEvent.setup();
  server();
  renderApp("/entries/lnk-p-coffee");
  await screen.findByRole("heading", { level: 1, name: "Edit entry" });
  await waitFor(() => expect(screen.getByLabelText("Merchant")).toHaveValue("BLUE BOTTLE COFFEE"));
  await user.click(screen.getByRole("button", { name: "Split this entry" }));
  await user.type(screen.getByLabelText("Split off amount"), "5.00");
  const chips = screen.getByRole("group", { name: "Category for the split part" });
  await user.click(within(chips).getByRole("radio", { name: "Dining" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { level: 1, name: "Money in & out" });
}

/** The coffee posts at $22 with the tip. */
async function posted(db: StackdDb) {
  await applySync(
    db,
    "bc1",
    page({
      removed: ["p-coffee"],
      added: [
        txn({
          transaction_id: "t-coffee",
          date: "2026-10-16",
          amount_cents: 2200,
          description: "BLUE BOTTLE COFFEE",
          pending_transaction_id: "p-coffee",
        }),
      ],
    }),
    NOW,
  );
}

describe("a month through every money path (docs/invariants.md)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every bank cent is counted once, whatever happened to the entry", async () => {
    const db = await theMonth();
    await splitCoffee();
    await posted(db);
    const entries = await db.entries.toArray();
    // The coffee: the posted entry plus its part make the bank's $22, and the part kept its $5
    const coffee = entries.filter(
      (e) => e.id === "lnk-t-coffee" || e.split_parent_id === "lnk-t-coffee",
    );
    expect(coffee.map((e) => e.amount_cents).sort((a, b) => a - b)).toEqual([500, 1700]);
    expect(entries.find((e) => e.id === "lnk-p-coffee")).toBeUndefined();
    // The transfer: both sides marked and linked to each other
    const sides = entries.filter((e) => e.is_transfer);
    expect(sides).toHaveLength(2);
    expect(sides[0]?.transfer_pair_id).toBe(sides[1]?.id);
    expect(sides[1]?.transfer_pair_id).toBe(sides[0]?.id);
    // Counted money out: every entry not a transfer, not left out, adds up to the bank's rows
    const out = entries
      .filter((e) => e.direction === "out" && !e.is_transfer && !e.not_counted)
      .reduce((s, e) => s + e.amount_cents, 0);
    expect(out).toBe(120000 + 2200 + 15000 + 6000);
  });

  it("a part split again still counts the bank's cents once after the coffee posts", async () => {
    const db = await theMonth();
    await splitCoffee();
    cleanup();
    // Split $2 off the $5 part in the editor too
    const part = (await db.entries.toArray()).find((e) => e.split_parent_id === "lnk-p-coffee");
    const user = userEvent.setup();
    server();
    renderApp(`/entries/${(part as Entry).id}`);
    await screen.findByRole("heading", { level: 1, name: "Edit entry" });
    await waitFor(() => expect(screen.getByLabelText("Amount")).toHaveValue("5.00"));
    await user.click(screen.getByRole("button", { name: "Split this entry" }));
    await user.type(screen.getByLabelText("Split off amount"), "2.00");
    const chips = screen.getByRole("group", { name: "Category for the split part" });
    await user.click(within(chips).getByRole("radio", { name: "Groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });
    await posted(db);
    const entries = await db.entries.toArray();
    const coffee = entries
      .filter((e) => e.merchant === "BLUE BOTTLE COFFEE")
      .map((e) => e.amount_cents)
      .sort((a, b) => a - b);
    expect(coffee).toEqual([200, 300, 1700]);
    const out = entries
      .filter((e) => e.direction === "out" && !e.is_transfer && !e.not_counted)
      .reduce((s, e) => s + e.amount_cents, 0);
    expect(out).toBe(120000 + 2200 + 15000 + 6000);
  });

  it("a split entry after the balance counts the bank's amount once in every balance", async () => {
    const db = await theMonth();
    // Checking's balance entered on Oct 17, then $100 at the hardware store on Oct 18, split
    // $30 off to Groceries in the editor's way: the entry keeps $70, the part holds $30
    await db.balance_anchors.where("account_id").equals(CHECKING.id).delete();
    await db.balance_anchors.add({
      id: "anchor-chk",
      account_id: CHECKING.id,
      as_of: "2026-10-17",
      balance_cents: 500000,
      source: "user",
      created_at: "2026-10-17T09:00:00Z",
    });
    const base: Entry = {
      id: "hw",
      date: "2026-10-18",
      amount_cents: 7000,
      direction: "out",
      merchant: "HARDWARE STORE",
      clean_description: "HARDWARE STORE",
      raw_description: null,
      category_id: "cat-shopping",
      account_id: CHECKING.id,
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:00:00Z",
    };
    await db.entries.bulkAdd([
      base,
      {
        ...base,
        id: "hw-part",
        amount_cents: 3000,
        category_id: "cat-groceries",
        split_parent_id: "hw",
      },
    ]);
    // By hand: $5,000 − $100 = $4,900 (the coffee posted on Oct 16, before the balance)
    server();
    renderApp("/forecast");
    const how = await screen.findByText(/^Starting balance/);
    await waitFor(() => expect(how.nextElementSibling).toHaveTextContent("$4,900.00"));
    cleanup();
    server();
    renderApp("/net-worth");
    const own = await screen.findByRole("heading", { level: 2, name: /What you own/ });
    await waitFor(() => expect(own).toHaveTextContent("$4,900.00"));
    const chart = await screen.findByRole("img", { name: /^Net worth:/ });
    await waitFor(() => expect(chart.getAttribute("aria-label")).toMatch(/\$4,900\.00 today/));
  });

  it("Home: Got · Spent · Kept and Set aside match the hand totals", async () => {
    const db = await theMonth();
    await posted(db);
    server();
    renderApp("/");
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() =>
      expect(hero).toHaveTextContent("Got $3,000.00 · Spent $1,432.00 · Kept $1,568.00"),
    );
    const aside = await screen.findByRole("link", { name: "Set aside this month, open Goals" });
    await waitFor(() =>
      expect(aside).toHaveTextContent("Set aside $300.00 of $1,040.00 this month"),
    );
  });

  it("Money in & out shows the same month", async () => {
    const db = await theMonth();
    await posted(db);
    server();
    renderApp("/money");
    const month = await screen.findByRole("group", { name: "This month" });
    await waitFor(() => expect(month).toHaveTextContent("In+$3,000.00"));
    expect(month).toHaveTextContent("Out−$1,432.00");
    expect(month).toHaveTextContent("Kept$1,568.00");
  });

  it("a transfer marked by hand moves both sides out of the month", async () => {
    // $250 from Checking to the card account, entered by hand on both sides, then one side
    // marked a transfer in the editor: In and Out stay the hand totals.
    const db = await theMonth();
    await posted(db);
    const side = (id: string, direction: "in" | "out", account_id: string): Entry => ({
      id,
      date: "2026-10-18",
      amount_cents: 25000,
      direction,
      merchant: "Move",
      clean_description: "Move",
      raw_description: null,
      category_id: null,
      account_id,
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
    });
    await db.entries.bulkAdd([
      side("hand-out", "out", "acct-chk"),
      side("hand-in", "in", "acct-cc"),
    ]);
    const user = userEvent.setup();
    server();
    renderApp("/entries/hand-out");
    const transfer = await screen.findByRole("switch", { name: /Transfer between my accounts/ });
    await waitFor(() => expect(transfer).not.toBeChecked());
    await user.click(transfer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect(await db.entries.get("hand-in")).toMatchObject({ is_transfer: true }),
    );
    cleanup();
    renderApp("/money");
    const month = await screen.findByRole("group", { name: "This month" });
    await waitFor(() => expect(month).toHaveTextContent("In+$3,000.00"));
    expect(month).toHaveTextContent("Out−$1,432.00");
    expect(month).toHaveTextContent("Kept$1,568.00");
  });

  it("Insights shows the same Kept", async () => {
    const db = await theMonth();
    await posted(db);
    server();
    renderApp("/insights");
    const money = await screen.findByRole("link", { name: "Money in & out" });
    await waitFor(() => expect(money).toHaveTextContent("$1,568.00 kept"));
  });

  it("the jars hold what the goal screens say: $200 and $100", async () => {
    await theMonth();
    server();
    renderApp("/goals/jar-ef");
    await screen.findByRole("heading", { level: 1, name: "Emergency fund" });
    await waitFor(() => expect(screen.getByRole("main")).toHaveTextContent("$200.00"));
  });

  it("the weekly recap: the coffee only, and no new money into jars", async () => {
    const db = await theMonth();
    await posted(db);
    server();
    renderApp("/recap");
    const week = await screen.findByRole("region", { name: "The last 7 days" });
    await waitFor(() => expect(week).toHaveTextContent("Spent $22.00"));
    const jars = screen.getByRole("region", { name: "Jars" });
    await waitFor(() => expect(jars).toHaveTextContent("No deposits these 7 days"));
  });
});
