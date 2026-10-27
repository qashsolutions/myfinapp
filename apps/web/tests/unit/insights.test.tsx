/**
 * Fast-follow 8 insights on screen: safe to spend (Home and Next 30 days), bigger months
 * ahead, running higher than usual and spending by account (Money in & out), and the
 * consolidation what-if (Bills → Debt payoff). The arithmetic is golden-tested in both
 * engines; these check the wiring, the wording and that nothing leaves the device.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, type RecurringSeries, seedDefaults } from "../../src/data/db.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");
const STAMP = "2026-10-01T00:00:00Z";

function entry(
  id: string,
  date: string,
  cents: number,
  category: string | null,
  account = "acct-cash",
  direction: "in" | "out" = "out",
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant: id,
    clean_description: id.toUpperCase(),
    raw_description: null,
    category_id: category,
    account_id: account,
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

function series(
  id: string,
  label: string,
  kind: "bill" | "income",
  cents: number,
  interval: RecurringSeries["interval"],
  next: string,
): RecurringSeries {
  return {
    id,
    payee: label.toUpperCase(),
    label,
    kind,
    expected_cents: cents,
    interval,
    next_date: next,
    status: "confirmed",
    source: "manual",
    account_id: "acct-cash",
    created_at: STAMP,
    updated_at: STAMP,
  };
}

/** Leak check: no request from these screens carries an amount or a merchant. */
function noMoneyLeft(api: FakeApi) {
  for (const c of api.calls) {
    expect(JSON.stringify(c.body ?? {})).not.toMatch(/cents|amount|merchant|GEICO|Dining/i);
  }
}

describe("insights (fast-follow 8)", () => {
  let api: FakeApi;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    api = installFakeApi({ session: readySession() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows safe to spend until payday and the bigger months ahead", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("Corner Market", "2026-10-08", 4500, "cat-groceries"));
    await db.balance_anchors.add({
      id: "anchor-1",
      account_id: "acct-cash",
      as_of: "2026-10-05",
      balance_cents: 210000,
      source: "statement",
      created_at: STAMP,
    });
    await db.recurring_series.bulkAdd([
      series("s-pay", "Paycheck", "income", 240000, "biweekly", "2026-10-16"),
      series("s-rent", "Rent", "bill", 165000, "monthly", "2026-10-25"),
      series("s-geico", "Geico", "bill", 78000, "quarterly", "2026-11-15"),
    ]);

    renderApp("/forecast");
    const chart = await screen.findByRole("region", { name: "Estimated balance" });
    await waitFor(() =>
      expect(chart).toHaveTextContent(
        /Safe to spend until payday \(Oct 16\): \$[\d,]+\.\d\d, about \$[\d,]+\.\d\d a day/,
      ),
    );
    expect(chart).toHaveTextContent("beyond your usual spending, keeping your cushion");

    const bigger = await screen.findByRole("region", { name: "Bigger months ahead" });
    // Oct and Nov inclusive: round_div(78000, 2) = 39000
    expect(bigger).toHaveTextContent("Geico · $780.00");
    expect(bigger).toHaveTextContent("every 3 months, next Nov 15");
    expect(bigger).toHaveTextContent("Set aside $390.00 a month");

    renderApp("/");
    const home = await screen.findByRole("region", { name: "Next 30 days" });
    await waitFor(() => expect(home).toHaveTextContent(/\$[\d,]+\.\d\d a day to spend/));
    expect(home).toHaveTextContent("Until payday, Oct 16, after bills");
    noMoneyLeft(api);
  });

  it("flags categories running higher than usual and splits spending by account", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.accounts.add({
      id: "acct-card",
      label: "Visa",
      type: "credit_card",
      last4: "1234",
      institution: null,
      currency: "USD",
      created_at: STAMP,
    });
    await db.entries.bulkAdd([
      entry("Dining Oct", "2026-10-03", 9000, "cat-dining", "acct-card"),
      entry("Groceries Oct", "2026-10-04", 5000, "cat-groceries"),
      entry("Dining Sep", "2026-09-05", 2000, "cat-dining"),
      entry("Dining Aug", "2026-08-06", 2000, "cat-dining"),
    ]);
    renderApp("/money");
    const higher = await screen.findByRole("region", { name: "Running higher than usual" });
    // usual = round_div(2000 + 2000, 2) = 2000; increase 7000
    expect(higher).toHaveTextContent("Dining");
    expect(higher).toHaveTextContent("$90.00 so far vs about $20.00 by this point");
    expect(higher).toHaveTextContent("+$70.00");
    expect(higher).toHaveTextContent("Compared with the same days of your last 2 months");

    const byAccount = screen.getByRole("region", { name: "Spending by account" });
    const rows = within(byAccount).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Visa.*\$90\.00/),
      expect.stringMatching(/Cash.*\$50\.00/),
    ]);
    noMoneyLeft(api);
  });

  it("compares moving card balances with paying them as they are, without naming any lender", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.debts.add({
      id: "d-card",
      label: "Card",
      balance_cents: 100000,
      apr_bps: 2400,
      min_payment_cents: 2500,
      created_at: STAMP,
      updated_at: STAMP,
    });
    const user = userEvent.setup();
    renderApp("/bills");
    await user.click(await screen.findByRole("radio", { name: "Debt payoff" }));
    const calc = await screen.findByRole("region", { name: "What if I moved these balances?" });
    const type = async (label: string, value: string) => {
      const input = within(calc).getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    };
    await type("Rate after any intro period (APR %)", "22");
    await type("Transfer or setup fee (%)", "3");
    await type("Intro months (0 if none)", "12");
    await type("Intro rate (APR %)", "0");
    await type("Monthly payment", "500");
    await user.click(within(calc).getByRole("button", { name: "Compare" }));
    // the bills.consolidation golden: 3 months either way, $31.01 interest today vs a $30 fee
    const result = await within(calc).findByRole("status", { name: "Comparison" });
    expect(result).toHaveTextContent("As they are3 months · $31.01 interest");
    expect(result).toHaveTextContent("3 months · $30.00 interest and fees");
    expect(result).toHaveTextContent("Moving would cost $1.01 less.");
    expect(calc).toHaveTextContent("not advice or an offer");

    await type("Monthly payment", "20");
    await user.click(within(calc).getByRole("button", { name: "Compare" }));
    expect(await within(calc).findByRole("alert")).toHaveTextContent(
      "The monthly payment must cover your minimums, $25.00.",
    );
    noMoneyLeft(api);
  });
});
