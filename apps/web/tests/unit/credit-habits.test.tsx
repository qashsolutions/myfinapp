import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("a card without a due day asks for one, and the due day is the person's own value", async () => {
    const user = userEvent.setup();
    const db = await seedCard();
    await db.accounts.update(VISA.id, { due_day: null });
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    const card = await screen.findByRole("article", { name: "Visa ••4242" });
    await waitFor(() => expect(card).toHaveTextContent("No due date yet"));
    expect(card).toHaveTextContent("Start");

    await user.click(within(card).getByRole("link", { name: "Set a payment due day" }));
    const visa = await screen.findByRole("region", { name: "Visa" });
    await user.click(within(visa).getByRole("button", { name: "Edit or remove" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit account" });
    await user.type(within(sheet).getByLabelText("Own due day, 1 to 31"), "32");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Pick a day from 1 to 31.");
    await user.clear(within(sheet).getByLabelText("Own due day, 1 to 31"));
    await user.type(within(sheet).getByLabelText("Own due day, 1 to 31"), "20");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
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
    // Kept on this device and in the export (never in backups, like card_details).
    const files = await collectExport(db, null, NOW.toISOString());
    const settings = JSON.parse(
      new TextDecoder().decode(files.find((f) => f.name === "settings.json")?.data),
    );
    expect(settings.card_due_dates).toHaveLength(2);
  });
});
