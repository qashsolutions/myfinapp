import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildInputs } from "../../src/data/alertSchedule.ts";
import { type Account, type CardDetail, openDb, seedDefaults } from "../../src/data/db.ts";
import { syncConnection } from "../../src/features/linking/sync.ts";
import { momentsLog } from "../../src/moments/bus.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const NOW = new Date("2026-10-12T12:00:00");

const CARD: Account = {
  id: "acct-cc",
  label: "Card",
  type: "credit_card",
  last4: "3333",
  institution: "First Platypus Bank",
  currency: "USD",
  created_at: "2026-09-01T00:00:00Z",
  linked: { connection_id: "bc1", account_id: "acc-cc" },
};

const FACTS: Omit<CardDetail, "account_id" | "updated_at"> = {
  statement_balance_cents: 41200,
  statement_date: "2026-10-01",
  due_date: "2026-10-28",
  minimum_cents: 2500,
  last_payment_cents: 16837,
  last_payment_date: "2026-09-16",
  limit_cents: 200000,
  apr_bps: 2499,
  is_overdue: false,
};

function connected() {
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
  return api;
}

async function seed(facts: Partial<CardDetail> = {}) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.put(CARD);
  await db.card_details.put({
    ...FACTS,
    ...facts,
    account_id: CARD.id,
    updated_at: NOW.toISOString(),
  });
  // Weekly pay from Oct 15: paydays Oct 15 and Oct 22 fall before the Oct 28 due date.
  await db.settings.put({
    key: "pay",
    value: {
      amount_cents: 100000,
      frequency: "weekly",
      next_payday: "2026-10-15",
      monthly_cents: 433333,
    },
    updated_at: NOW.toISOString(),
  });
  return db;
}

async function openDebtTab() {
  const user = userEvent.setup();
  renderApp("/bills");
  await user.click(await screen.findByRole("radio", { name: "Debt payoff" }));
  return screen.findByRole("article", { name: "Card ••3333" });
}

describe("linked card details (chunk 3.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    momentsLog.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("a sync pulls the card's facts onto the device, keyed by the device account", async () => {
    const db = openDb("u1");
    await db.accounts.put(CARD);
    const api = connected();
    api.linking.cards.bc1 = [{ account_id: "acc-cc", ...FACTS }];
    await syncConnection(db, "bc1", NOW);
    expect(await db.card_details.get("acct-cc")).toMatchObject({
      statement_balance_cents: 41200,
      due_date: "2026-10-28",
      apr_bps: 2499,
    });
    const call = api.calls.find((c) => c.path === "/api/linking/bc1/cards");
    expect(call?.body ?? {}).toEqual({}); // nothing goes up but the connection id
  });

  it("shows balance, due countdown, limit used, minimum, APR and the payday split", async () => {
    await seed();
    connected();
    const card = await openDebtTab();
    const c = within(card);
    expect(card.querySelector(".card-facts__balance")?.textContent).toMatch(/^\$412\.00Statement/);
    expect(c.getByText("Due in 16 days")).toBeTruthy();
    // 41,200 / 200,000 = 2060 bps -> 21%
    expect(await c.findByRole("progressbar", { name: "Card ••3333 limit used" })).toHaveAttribute(
      "aria-valuetext",
      "21% of $2,000.00 limit",
    );
    expect(c.getByText("$25.00")).toBeTruthy();
    expect(c.getByText("24.99%")).toBeTruthy();
    expect(c.getByText(/Pay \$412\.00 by .*Oct.* 28 to clear the statement\./)).toBeTruthy();
    const split = c.getByRole("list", { name: "Split across your paydays" });
    expect(within(split).getAllByText("$206.00")).toHaveLength(2);
  });

  it("a statement paid in full says so and celebrates once", async () => {
    await seed({ last_payment_cents: 41200, last_payment_date: "2026-10-05" });
    connected();
    const card = await openDebtTab();
    expect(await within(card).findByText("Paid in full. Nice.")).toBeTruthy();
    await waitFor(() => expect(momentsLog.some((m) => m.type === "card_paid")).toBe(true));
  });

  it("the due date joins the reminder schedule as an upcoming bill, and a paid card does not", async () => {
    const db = await seed();
    const base = {
      nowLocal: "2026-10-12T12:00",
      asOf: "2026-10-12",
      upcoming: null,
      projection: null,
      challenges: [],
      goals: [],
      milestonesReached: [],
      prefs: {},
    };
    const inputs = await buildInputs(db, base as never);
    expect(inputs.upcoming).toEqual([
      { series_id: "card-acct-cc", date: "2026-10-28", kind: "bill", matched: false },
    ]);
    await db.card_details.update("acct-cc", {
      last_payment_cents: 41200,
      last_payment_date: "2026-10-05",
    });
    expect((await buildInputs(db, base as never)).upcoming).toEqual([]);
  });

  it("a card that is no longer linked is not shown", async () => {
    const db = await seed();
    await db.accounts.put({ ...CARD, linked: null });
    connected();
    const user = userEvent.setup();
    renderApp("/bills");
    await user.click(await screen.findByRole("radio", { name: "Debt payoff" }));
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("heading", { name: "Your cards" })).toBeNull();
  });
});
