import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Account, type CardDetail, openDb, seedDefaults } from "../../src/data/db.ts";
import { payoffPlan, whatIfDebt } from "../../src/engine/bridge.ts";
import { readPlanDebts } from "../../src/features/bills/debtPlan.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

// Invariant 65: a linked card is a debt in the payoff plan, counted once.
const TODAY = new Date("2026-10-10T12:00:00");

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

const FACTS: CardDetail = {
  account_id: CARD.id,
  statement_balance_cents: 18000,
  statement_date: "2026-10-01",
  due_date: "2026-10-28",
  minimum_cents: 2000,
  last_payment_cents: null,
  last_payment_date: null,
  limit_cents: 200000,
  apr_bps: 2400,
  is_overdue: false,
  updated_at: "2026-10-10T00:00:00Z",
};

/** The connection the card is read through, so the device keeps it linked. */
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
  await db.card_details.put({ ...FACTS, ...facts });
  // What is owed now is the bank's balance: a card's anchor is negative.
  await db.balance_anchors.put({
    id: "lnk-bal-acct-cc-2026-10-10",
    account_id: CARD.id,
    as_of: "2026-10-10",
    balance_cents: -20000,
    source: "linked",
    created_at: "2026-10-10T10:00:00Z",
  });
  await db.settings.put({ key: "debt.extra_cents", value: 5000, updated_at: "x" });
  return db;
}

describe("linked cards in the payoff plan (invariant 65)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => vi.useRealTimers());

  it("puts a linked card in the plan at the bank's balance, the issuer's APR and minimum", async () => {
    await seed();
    connected();
    renderApp("/bills?tab=debt");
    const list = await screen.findByRole("list", { name: "Debts, highest rate first" });
    expect(
      await within(list).findByRole("button", {
        name: "Card ••3333, 24.00% APR, balance $200.00, rank 1",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No cards or loans yet/)).toBeNull();
    // Worked by hand (as on Home's card test): $200 at 24% paying $20 + $50 extra is paid off
    // in the third month counted from November: January 2027.
    const plan = await screen.findByRole("region", { name: "Payoff plan" });
    await waitFor(() => expect(plan).toHaveTextContent("January 2027"));
  });

  it("feeds Home's Debt-free card with a linked card alone", async () => {
    await seed();
    connected();
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Open Debt payoff" }, { timeout: 3000 });
    await waitFor(() => expect(card).toHaveTextContent("Jan 2027"));
  });

  it("asks once for an APR the issuer didn't send, then uses it", async () => {
    const user = userEvent.setup();
    const db = await seed({ apr_bps: null });
    connected();
    renderApp("/bills?tab=debt");
    const need = await screen.findByRole("group", { name: "Card ••3333 needs details" });
    expect(need).toHaveTextContent("First Platypus Bank didn't send Card ••3333's APR.");
    expect((await readPlanDebts(db)).debts).toEqual([]);
    await user.click(within(need).getByRole("button", { name: "Add APR" }));
    const sheet = await screen.findByRole("dialog", { name: "Card ••3333" });
    // Suggestions plus the card's own rate, 0% to 40% (owner decision, October 29, 2026).
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Pick a rate or type your card's own.",
    );
    const box = within(sheet).getByLabelText("Your card's APR %");
    await user.type(box, "45");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Card rates are between 0% and 40%.",
    );
    await user.clear(box);
    await user.type(box, "40");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(within(sheet).queryByRole("alert")).toBeNull());
    await user.click(within(sheet).getByRole("radio", { name: "24.99%" }));
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await db.settings.get("debt.card.acct-cc")).toMatchObject({ value: { apr_bps: 2499 } });
    const list = await screen.findByRole("list", { name: "Debts, highest rate first" });
    expect(
      await within(list).findByRole("button", {
        name: "Card ••3333, 24.99% APR, balance $200.00, rank 1",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Card ••3333 needs details" })).toBeNull();
  });

  it("a debt added by hand takes the same 0% to 40% range", async () => {
    const user = userEvent.setup();
    await seed();
    connected();
    renderApp("/bills?tab=debt");
    await screen.findByRole("list", { name: "Debts, highest rate first" });
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a card or loan" });
    await user.type(within(sheet).getByLabelText("Name"), "Store card");
    await user.type(within(sheet).getByLabelText("Balance"), "500");
    await user.type(within(sheet).getByLabelText("APR %"), "41");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Card rates are between 0% and 40%.",
    );
  });

  it("a loan takes up to 400%: above 40% it asks once, then saves; past 400% is refused", async () => {
    const user = userEvent.setup();
    const db = await seed();
    connected();
    renderApp("/bills?tab=debt");
    await screen.findByRole("list", { name: "Debts, highest rate first" });
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a card or loan" });
    await user.type(within(sheet).getByLabelText("Name"), "Payday loan");
    // The name made it a loan; the person can change the kind.
    expect(within(sheet).getByRole("radio", { name: "Loan" })).toBeChecked();
    await user.type(within(sheet).getByLabelText("Balance"), "500");
    const apr = within(sheet).getByLabelText("APR %");
    await user.type(apr, "401");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Rates are between 0% and 400%.",
    );
    await user.clear(apr);
    await user.type(apr, "300");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    const ask = await within(sheet).findByRole("group", { name: "Check the rate" });
    expect(ask).toHaveTextContent("That's a very high rate. Is it right?");
    expect(await db.debts.count()).toBe(0); // nothing saved before the answer
    await user.click(within(ask).getByRole("button", { name: "Fix it" }));
    expect(within(sheet).queryByRole("group", { name: "Check the rate" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    await user.click(
      within(await within(sheet).findByRole("group", { name: "Check the rate" })).getByRole(
        "button",
        { name: "Yes, it's right" },
      ),
    );
    await waitFor(async () =>
      expect(await db.debts.toArray()).toMatchObject([
        { label: "Payday loan", apr_bps: 30000, kind: "loan" },
      ]),
    );
    // Saved and closed.
    expect(screen.queryByRole("dialog", { name: "Add a card or loan" })).toBeNull();
  });

  it("the plan and What if take a 400% loan without breaking: it stalls", async () => {
    const debts = [
      { id: "p", label: "Payday", balance_cents: 50000, apr_bps: 40000, min_payment_cents: 5000 },
    ];
    // 400% a year is a third of the balance a month: $166.67 interest on $500 > $50 paid.
    const plan = await payoffPlan(debts, 0, "2026-10-10", "avalanche");
    expect(plan).toMatchObject({ stalled: true, months: null, debt_free_month: null });
    const what = await whatIfDebt(debts, 0, 10000, "2026-10-10", "avalanche");
    expect(what.status).toBe("stalled");
    // With enough on top it ends: $500 at a third a month, paying $50 + $300 a month.
    const paid = await payoffPlan(debts, 30000, "2026-10-10", "avalanche");
    expect(paid.stalled).toBe(false);
  });

  it("a card also added by hand counts once after the person pairs them", async () => {
    const user = userEvent.setup();
    const db = await seed();
    await db.debts.add({
      id: "hand",
      label: "My Visa",
      balance_cents: 19000,
      apr_bps: 2200,
      min_payment_cents: 2500,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const before = await readPlanDebts(db);
    expect(before.debts.map((d) => d.id).sort()).toEqual(["card:acct-cc", "hand"]);
    connected();
    renderApp("/bills?tab=debt");
    expect(await screen.findByRole("note", { name: "Counted twice?" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Debts, highest rate first" });
    await user.click(await within(list).findByRole("button", { name: /^Card ••3333, / }));
    const sheet = await screen.findByRole("dialog", { name: "Card ••3333" });
    await user.click(within(sheet).getByRole("radio", { name: "My Visa" }));
    await waitFor(async () => expect((await db.debts.get("hand"))?.account_id).toBe("acct-cc"));
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("note", { name: "Counted twice?" })).toBeNull());
    // One debt: the hand-added name, the bank's balance, the issuer's APR and minimum.
    const after = await readPlanDebts(db);
    expect(after.debts).toHaveLength(1);
    expect(after.debts[0]).toMatchObject({
      id: "card:acct-cc",
      label: "My Visa",
      balance_cents: 20000,
      apr_bps: 2400,
      min_payment_cents: 2000,
    });
    // The list shows the one row.
    const view = await screen.findByRole("list", { name: "Debts, highest rate first" });
    expect(within(view).getAllByRole("button")).toHaveLength(1);
  });

  it("net worth owes a paired card once: the account, not the hand-added debt too", async () => {
    const db = await seed();
    await db.debts.add({
      id: "hand",
      label: "My Visa",
      balance_cents: 19000,
      apr_bps: 2200,
      min_payment_cents: 2500,
      account_id: "acct-cc",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    connected();
    renderApp("/net-worth");
    const owe = await screen.findByRole("heading", { name: /What you owe/ });
    await waitFor(() => expect(owe).toHaveTextContent("$200.00"));
    expect(screen.getByText("Card ••3333")).toBeInTheDocument();
    expect(screen.queryByText("My Visa")).toBeNull();
  });

  it("a card left out of the plan, or owing nothing, isn't in it", async () => {
    const db = await seed();
    await db.settings.put({
      key: "debt.card.acct-cc",
      value: { left_out: true },
      updated_at: "x",
    });
    expect((await readPlanDebts(db)).debts).toEqual([]);
    await db.settings.delete("debt.card.acct-cc");
    await db.balance_anchors.update("lnk-bal-acct-cc-2026-10-10", { balance_cents: 0 });
    const plan = await readPlanDebts(db);
    expect(plan.debts).toEqual([]);
    expect(plan.cards[0]?.status).toBe("nothing_owed");
  });
});
