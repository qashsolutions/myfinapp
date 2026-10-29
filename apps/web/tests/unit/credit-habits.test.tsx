import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSnapshot, mergeSnapshot } from "../../src/data/backup/snapshot.ts";
import {
  type Account,
  type CardDetail,
  type Entry,
  openDb,
  seedDefaults,
} from "../../src/data/db.ts";
import { collectExport } from "../../src/data/export.ts";
import { syncConnection } from "../../src/features/linking/sync.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const NOW = new Date("2026-10-20T12:00:00");

const VISA: Account = {
  id: "acct-visa",
  label: "Visa",
  type: "credit_card",
  last4: "4242",
  institution: null,
  currency: "USD",
  created_at: "2026-07-01T00:00:00Z",
  due_day: 15,
};

function entry(id: string, date: string, direction: "in" | "out", cents: number): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant: direction === "in" ? "Payment, thank you" : "Grocer",
    clean_description: direction === "in" ? "PAYMENT THANK YOU" : "GROCER",
    raw_description: null,
    category_id: null,
    account_id: VISA.id,
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: direction === "in",
    transfer_pair_id: null,
    is_recurring: false,
    split_parent_id: null,
    created_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
  };
}

/** The golden case credit.habits/nothing_before_the_cards_history_counts_as_missed on a card:
 * payments of $50 before each 15th from July, spending from July 3. */
async function seedCard() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.put(VISA);
  await db.entries.bulkAdd([
    entry("s1", "2026-07-03", "out", 9000),
    entry("p1", "2026-07-10", "in", 5000),
    entry("s2", "2026-08-03", "out", 8000),
    entry("p2", "2026-08-14", "in", 5000),
    entry("s3", "2026-09-03", "out", 12000),
    entry("p3", "2026-09-15", "in", 5000),
    entry("p4", "2026-10-12", "in", 5000),
  ]);
  // The card's balance was $0 on July 1, so what was owed on each 15th is known.
  await db.balance_anchors.add({
    id: "anc-visa",
    account_id: VISA.id,
    as_of: "2026-07-01",
    balance_cents: 0,
    source: "user",
    created_at: "2026-07-01T00:00:00Z",
  });
  return db;
}

describe("credit habits and card spending (October 28, 2026)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("a card with a due day shows its on-time streak and spending against payments on Debt payoff", async () => {
    await seedCard();
    installFakeApi({ session: readySession() });
    renderApp("/bills?tab=debt");
    const habits = await screen.findByRole("region", { name: /Credit habits/ });
    await waitFor(() => expect(habits).toHaveTextContent("4 payments on time in a row"));
    expect(habits).toHaveTextContent("Steady");
    expect(habits).toHaveTextContent("Education only. Qash never sees or shows a credit score.");
    const spending = await screen.findByRole("region", { name: "Card spending vs payments" });
    // credit.card_trend: Jul 9000/5000, Aug 8000/5000, Sep 12000/5000 → growing three months running.
    await waitFor(() => expect(spending).toHaveTextContent("Growing"));
    expect(spending).toHaveTextContent("Spent $120.00, paid $50.00 last month");
  });

  it("/credit-habits explains each card and says why, with no score and no advice", async () => {
    await seedCard();
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    await screen.findByRole("heading", { level: 1, name: "Credit habits" });
    const card = await screen.findByRole("article", { name: "Visa ••4242" });
    await waitFor(() => expect(card).toHaveTextContent("4 payments on time in a row"));
    expect(card).toHaveTextContent("Next due Nov 15");
    expect(document.body).toHaveTextContent("under 30% is a common guide");
    expect(document.body).not.toHaveTextContent(/you should/i);
  });

  it("Insights shows the Credit habits card once there is a card, and none without", async () => {
    await seedCard();
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: "Credit habits" });
    await waitFor(() => expect(card).toHaveTextContent("4 payments on time in a row"));
    expect(card).toHaveTextContent("Steady");
  });

  it("never says Missed when nothing was owed, and checks nothing until a balance is known", async () => {
    const db = await seedCard();
    // A quiet card: $0 on July 1, a $30 charge on Aug 3 paid on Aug 10, then nothing at all.
    await db.entries.clear();
    await db.entries.bulkAdd([
      entry("q1", "2026-08-03", "out", 3000),
      entry("q2", "2026-08-10", "in", 3000),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    const card = await screen.findByRole("article", { name: "Visa ••4242" });
    // Aug 15, Sep 15 and Oct 15 checked: Aug paid, Sep and Oct owed nothing.
    await waitFor(() => expect(card).toHaveTextContent("3 payments on time in a row"));
    expect(card).toHaveTextContent("Steady");
    expect(card).not.toHaveTextContent("Missed");

    await db.balance_anchors.clear();
    await waitFor(() => expect(card).toHaveTextContent("Set the card's balance to start checking"));
    expect(card).toHaveTextContent("Start");
    expect(card).not.toHaveTextContent("Missed");
    expect(within(card).getByRole("link", { name: "Set the balance in Accounts" })).toBeVisible();
  });

  it("never says Missed for a due date past what the card's statements reach", async () => {
    // A statement imported through Oct 20, due on the 25th, today Oct 28: the Oct 25 payment
    // simply isn't in yet (credit.habits `until`; golden due_dates_past_the_cards_data_are_unknown).
    vi.setSystemTime(new Date("2026-10-28T12:00:00"));
    const db = await seedCard();
    await db.accounts.update(VISA.id, { due_day: 25 });
    await db.entries.clear();
    await db.entries.bulkAdd([
      entry("a1", "2026-08-03", "out", 3000),
      entry("a2", "2026-08-20", "in", 3000),
      entry("b1", "2026-09-03", "out", 3000),
      entry("b2", "2026-09-20", "in", 3000),
      entry("c1", "2026-10-03", "out", 3000),
    ]);
    await db.balance_anchors.add({
      id: "anc-stmt",
      account_id: VISA.id,
      as_of: "2026-10-18",
      balance_cents: -3000,
      source: "statement",
      created_at: "2026-10-28T09:00:00Z",
    });
    await db.statement_imports.add({
      id: "imp-oct",
      account_id: VISA.id,
      format: "csv",
      template_key: null,
      file_name: "visa-october.csv",
      period_start: "2026-09-21",
      period_end: "2026-10-20",
      ending_balance_cents: -3000,
      rows_found: 1,
      rows_added: 1,
      rows_skipped: 0,
      file_key: null,
      status: "done",
      created_at: "2026-10-28T09:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    const card = await screen.findByRole("article", { name: "Visa ••4242" });
    await waitFor(() => expect(card).toHaveTextContent("2 payments on time in a row"));
    expect(card).toHaveTextContent("Steady");
    expect(card).not.toHaveTextContent("Missed");
  });

  it("a card without a due day asks for one, and the due day is the person's own value", async () => {
    const user = userEvent.setup();
    const db = await seedCard();
    await db.accounts.update(VISA.id, { due_day: null });
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    const card = await screen.findByRole("article", { name: "Visa ••4242" });
    await waitFor(() => expect(card).toHaveTextContent("No due date yet"));
    expect(card).toHaveTextContent("Start");

    // The due day is set in the screen's Adjust sheet (October 29, 2026), any day 1 to 31.
    await user.click(within(card).getByRole("button", { name: "Set a payment due day" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust credit habits" });
    const own = within(sheet).getByLabelText("Own due day for Visa, 1 to 31");
    await user.type(own, "32");
    const row = own.closest(".own-choice") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Use" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Pick a day from 1 to 31.");
    await user.clear(own);
    await user.type(own, "20");
    await user.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(async () => expect((await db.accounts.get(VISA.id))?.due_day).toBe(20));
  });

  it("a linked card's due dates are kept as each sync sees them and judged with what each statement asked", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const card: Account = {
      ...VISA,
      due_day: null,
      linked: { connection_id: "bc1", account_id: "acc-cc" },
    };
    await db.accounts.put(card);
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T00:00:00Z",
      status: "ok",
      updates_available: false,
      last_synced_at: null,
    });
    const facts = (
      due: string,
      balance: number,
    ): Omit<CardDetail, "account_id" | "updated_at"> => ({
      statement_balance_cents: balance,
      statement_date: null,
      due_date: due,
      minimum_cents: 2500,
      last_payment_cents: null,
      last_payment_date: null,
      limit_cents: 100000,
      apr_bps: 2499,
      is_overdue: false,
    });
    api.linking.cards.bc1 = [{ account_id: "acc-cc", ...facts("2026-09-25", 30000) }];
    await syncConnection(db, "bc1", new Date("2026-09-10T12:00:00"));
    api.linking.cards.bc1 = [{ account_id: "acc-cc", ...facts("2026-10-25", 15000) }];
    await syncConnection(db, "bc1", NOW);
    expect((await db.card_due_dates.toArray()).map((d) => d.due_date).sort()).toEqual([
      "2026-09-25",
      "2026-10-25",
    ]);
    await db.entries.bulkAdd([
      { ...entry("x1", "2026-09-01", "out", 30000), account_id: card.id },
      { ...entry("x2", "2026-09-24", "in", 30000), account_id: card.id },
    ]);
    renderApp("/credit-habits");
    const shown = await screen.findByRole("article", { name: "Visa ••4242" });
    await waitFor(() => expect(shown).toHaveTextContent("1 payment on time in a row"));
    expect(shown).toHaveTextContent("Paid in full 1 month");
    // 15000 of a 100000 limit: 15% · under 30%.
    expect(shown).toHaveTextContent("15% of your limit used · under 30%");
    // In the export, and in the encrypted backup so the history follows to a new device.
    const files = await collectExport(db, null, NOW.toISOString());
    const settings = JSON.parse(
      new TextDecoder().decode(files.find((f) => f.name === "settings.json")?.data),
    );
    expect(settings.card_due_dates).toHaveLength(2);
    const snapshot = await buildSnapshot(db, { rulesVersion: "test", deviceId: "d1" });
    expect(snapshot.tables.card_due_dates).toHaveLength(2);
    const other = openDb("u2");
    await mergeSnapshot(other, snapshot);
    expect((await other.card_due_dates.toArray()).map((d) => d.due_date).sort()).toEqual([
      "2026-09-25",
      "2026-10-25",
    ]);
    other.close();
  });
});
