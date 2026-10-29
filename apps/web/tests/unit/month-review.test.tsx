/**
 * Your month, the once-a-month review (October 28, 2026; docs/spec.md "Your month"): a whole
 * month's pieces from the hooks their own screens use, sections hidden when they have nothing,
 * and one change picked by `insights.one_change`.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import type { BudgetSummary } from "../../src/engine/bridge.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import {
  buildOptions,
  doneKey,
  mostOver,
  whatIfLink,
} from "../../src/features/monthreview/monthReview.ts";
import { prefillAmount } from "../../src/features/whatif/WhatIfScreen.tsx";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const NOV_3 = new Date("2026-11-03T12:00:00");
const STAMP = "2026-09-01T00:00:00Z";

function entry(id: string, date: string, cents: number, direction: "in" | "out", category: string) {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant: id,
    clean_description: id.toUpperCase(),
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  } as Entry;
}

async function seedMonths(withBudget = true) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    // October: in 3,000; rent 1,500 and dining 310 out → kept 1,190 = 3966.67 bps → 40%
    entry("pay-oct", "2026-10-01", 300000, "in", "cat-paycheck"),
    entry("rent-oct", "2026-10-01", 150000, "out", "cat-rent"),
    entry("dining-oct", "2026-10-10", 31000, "out", "cat-dining"),
    // September whole: kept 2,000 of 3,000 = 67%
    entry("pay-sep", "2026-09-01", 300000, "in", "cat-paycheck"),
    entry("dining-sep", "2026-09-10", 100000, "out", "cat-dining"),
    // November so far: never part of October's review
    entry("dining-nov", "2026-11-02", 99900, "out", "cat-dining"),
  ]);
  if (withBudget)
    // Zero-based: Dining planned 190, spent 310 → 120 over; Rent on plan
    await createBudget(db, "2026-10", "zero_based", 300000, [
      { category_id: "cat-dining", planned_cents: 19000 },
      { category_id: "cat-rent", planned_cents: 150000 },
    ]);
  return db;
}

describe("Your month", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOV_3);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows how October went, the budget, jars and the one change", async () => {
    const db = await seedMonths();
    await db.goals.add({
      id: "g-bike",
      kind: "save",
      title: "Bike",
      target_cents: 50000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-09-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: STAMP,
      updated_at: STAMP,
    });
    await db.goal_events.add({
      id: "ev-1",
      goal_id: "g-bike",
      date: "2026-10-15",
      type: "deposit",
      amount_cents: 50000,
      created_at: "2026-10-15T10:00:00Z",
    });
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    expect(await screen.findByRole("heading", { name: "Your month", level: 1 })).toBeVisible();

    const how = await screen.findByRole("region", { name: "How it went" });
    await waitFor(() => expect(how).toHaveTextContent("40% kept"));
    // 40% in October against 67% in September
    expect(how).toHaveTextContent("Down");
    expect(how).toHaveTextContent("Kept $1,190.00");
    expect(how).toHaveTextContent("September 2026: 67% kept");

    const budget = screen.getByRole("region", { name: "Budget" });
    await waitFor(() => expect(budget).toHaveTextContent("1 line over · Dining $120.00 over"));
    expect(budget).toHaveTextContent("Over");

    const jars = await screen.findByRole("region", { name: "Jars" });
    await waitFor(() => expect(jars).toHaveTextContent("Reached"));
    expect(jars).toHaveTextContent("$500.00 new money into 1 jar");
    expect(jars).toHaveTextContent("Bike reached its target.");

    // Nothing to say: no debts, no cards, no subscriptions
    expect(screen.queryByRole("region", { name: "Debt" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Subscriptions" })).toBeNull();

    const change = await screen.findByRole("region", { name: "One change" });
    await waitFor(() =>
      expect(change).toHaveTextContent("Trim Dining by $120.00 a month → $1,440.00 a year"),
    );
    expect(change).toHaveTextContent("not advice");
    expect(within(change).getByRole("link", { name: "Try it in What if" })).toHaveAttribute(
      "href",
      "/what-if?lever=spend&amount=12000&category=cat-dining",
    );
    const stored = await db.computed_results.get("one_change:2026-10-31");
    expect(stored?.rules_version).toMatch(/^\d+\.\d+\.\d+$/);

    // Never the month in progress: Later is off; Earlier goes to September (its first entry)
    expect(screen.getByRole("button", { name: "Later ›" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "‹ Earlier" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "How it went" })).toHaveTextContent("67% kept"),
    );
    expect(screen.getByRole("button", { name: "‹ Earlier" })).toBeDisabled();
    // September had no budget: the section is left out
    expect(screen.queryByRole("region", { name: "Budget" })).toBeNull();
  });

  it("Home shows the card in a month's first week until Done", async () => {
    const db = await seedMonths();
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", {
      name: /Your month: October 2026: \$1,190.00 kept/,
    });
    await user.click(card);
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(async () =>
      expect((await db.settings.get(doneKey("2026-10")))?.value).toBe(true),
    );
    expect(await screen.findByRole("link", { name: /Kept this month/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Your month:/ })).toBeNull();
  });

  it("Home leaves the card out after the first week", async () => {
    vi.setSystemTime(new Date("2026-11-10T12:00:00"));
    await seedMonths();
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("link", { name: /Kept this month/ });
    expect(screen.queryByRole("link", { name: /Your month:/ })).toBeNull();
  });

  it("opens from Insights", async () => {
    await seedMonths(false);
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: "Your month" });
    await waitFor(() => expect(card).toHaveTextContent("October 2026: $1,190.00 kept"), {
      timeout: 5000,
    });
    expect(card).toHaveTextContent("Kept");
  });

  it("with nothing over plan, the one change is $50 a month on the debts", async () => {
    const db = await seedMonths(false);
    await db.debts.add({
      id: "d-card",
      label: "Card",
      balance_cents: 30000,
      apr_bps: 1200,
      min_payment_cents: 10000,
      created_at: STAMP,
      updated_at: STAMP,
    });
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    const change = await screen.findByRole("region", { name: "One change" });
    // Minimums only: 4 months, interest 300 + 203 + 105 + 6 = $6.14; with $50 more: 3 months,
    // 300 + 153 + 5 = $4.58. Saved $1.56 over today's 4 months = $4.68 a year.
    await waitFor(() =>
      expect(change).toHaveTextContent(
        "Put $50.00 a month on your debts → about $4.68 a year less interest",
      ),
    );
    expect(within(change).getByRole("link", { name: "Try it in What if" })).toHaveAttribute(
      "href",
      "/what-if?lever=debts&amount=5000",
    );
    expect(await screen.findByRole("region", { name: "Debt" })).toHaveTextContent("Debt-free");
    expect(screen.queryByRole("region", { name: "Budget" })).toBeNull();
  });

  it("the debt candidate follows the person's own order", async () => {
    const db = await seedMonths(false);
    await db.debts.bulkAdd([
      {
        id: "a",
        label: "Card A",
        balance_cents: 10000,
        apr_bps: 2400,
        min_payment_cents: 1000,
        created_at: STAMP,
        updated_at: STAMP,
      },
      {
        id: "b",
        label: "Loan B",
        balance_cents: 3000,
        apr_bps: 0,
        min_payment_cents: 1000,
        created_at: STAMP,
        updated_at: STAMP,
      },
    ]);
    await db.settings.put({ key: "debt.order", value: "snowball", updated_at: STAMP });
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    const change = await screen.findByRole("region", { name: "One change" });
    // Minimums only: 7 months, $9.31 interest either way. $50 more, smallest balance first:
    // B goes in month 1, A in month 2 (interest 200 + 124) → saved 931 − 324 = 607;
    // 607 × 12 ÷ 7 = 1040.57 → $10.41 a year (highest rate first would say $11.09).
    await waitFor(() =>
      expect(change).toHaveTextContent(
        "Put $50.00 a month on your debts → about $10.41 a year less interest",
      ),
    );
  });

  it("subscriptions belong to the month just ended only", async () => {
    const db = await seedMonths(false);
    await db.recurring_series.add({
      id: "s-hulu",
      payee: "HULU",
      label: "Hulu",
      kind: "bill",
      expected_cents: 1800,
      interval: "monthly",
      next_date: "2026-11-15",
      status: "confirmed",
      source: "detected",
      account_id: null,
      subscription: true,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    const subs = await screen.findByRole("region", { name: "Subscriptions" });
    await waitFor(() => expect(subs).toHaveTextContent("1 to check · $216.00 a year"));
    const change = await screen.findByRole("region", { name: "One change" });
    await waitFor(() => expect(change).toHaveTextContent("Check 1 subscription → $216.00 a year"));
    await user.click(screen.getByRole("button", { name: "‹ Earlier" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "How it went" })).toHaveTextContent("67% kept"),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "One change" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Subscriptions" })).toBeNull();
  });

  it("What if's debt levers follow the person's own order", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.debts.bulkAdd([
      {
        id: "a",
        label: "Card A",
        balance_cents: 10000,
        apr_bps: 2400,
        min_payment_cents: 1000,
        created_at: STAMP,
        updated_at: STAMP,
      },
      {
        id: "b",
        label: "Loan B",
        balance_cents: 3000,
        apr_bps: 0,
        min_payment_cents: 1000,
        created_at: STAMP,
        updated_at: STAMP,
      },
    ]);
    await db.settings.put({ key: "debt.order", value: "snowball", updated_at: STAMP });
    installFakeApi({ session: readySession() });
    // $30 more, smallest balance first (the whatif.debt golden): 7 months → 3, $5.00 less
    renderApp("/what-if?lever=debts&amount=3000");
    const card = await screen.findByRole("region", { name: "Extra on all debts" });
    await waitFor(() => expect(card).toHaveTextContent("smallest balance first"));
    const result = await screen.findByRole("region", { name: "What changes for your debts" });
    await waitFor(() =>
      expect(result).toHaveTextContent("Debt-free 4 months sooner · $5.00 less interest"),
    );
  });

  it("What if opens prefilled from the address", async () => {
    await seedDefaults(openDb("u1"));
    installFakeApi({ session: readySession() });
    renderApp("/what-if?lever=spend&category=cat-groceries&amount=12000");
    const card = await screen.findByRole("region", { name: "Spend less" });
    await waitFor(() =>
      expect(within(card).getByRole("combobox", { name: "Category" })).toHaveValue("cat-groceries"),
    );
    expect(card).toHaveTextContent("Then put the $120.00 a month toward a jar or your debts.");
    expect(prefillAmount("12000")).toBe(12000);
    expect(prefillAmount("0")).toBeNull();
    expect(prefillAmount("12.5")).toBeNull();
    expect(prefillAmount("-5")).toBeNull();
    expect(prefillAmount(null)).toBeNull();
  });

  it("builds over_plan from the most-over line or bucket", () => {
    const summary = (over: Partial<BudgetSummary>): BudgetSummary =>
      ({
        start: "2026-10-01",
        end: "2026-10-31",
        method: "zero_based",
        take_home_cents: 0,
        buckets: [],
        categories: [],
        uncategorized_cents: 0,
        total_spent_cents: 0,
        left_to_assign_cents: null,
        kept_cents: 0,
        ...over,
      }) as BudgetSummary;
    // Zero-based ties keep the summary's order
    expect(
      mostOver(
        summary({
          categories: [
            { category_id: "a", bucket: "want", planned_cents: 100, spent_cents: 150 },
            { category_id: "b", bucket: "want", planned_cents: 100, spent_cents: 150 },
            { category_id: "c", bucket: "need", planned_cents: null, spent_cents: 999 },
          ],
        }),
      ),
    ).toEqual({ category_id: "a", bucket: null, over_cents: 50, whatif_category: "a" });
    // 50/30/20: needs before wants on a tie; What if opens on the bucket's largest spending
    const bucket = mostOver(
      summary({
        method: "50_30_20",
        buckets: [
          { bucket: "need", planned_cents: 100, spent_cents: 130, left_cents: -30 },
          { bucket: "want", planned_cents: 100, spent_cents: 130, left_cents: -30 },
          { bucket: "save", planned_cents: 100, spent_cents: 500, left_cents: -400 },
        ],
        categories: [
          { category_id: "groceries", bucket: "need", planned_cents: null, spent_cents: 90 },
          { category_id: "rent", bucket: "need", planned_cents: null, spent_cents: 40 },
        ],
      }),
    );
    expect(bucket).toEqual({
      category_id: null,
      bucket: "need",
      over_cents: 30,
      whatif_category: "groceries",
    });
    expect(mostOver(summary({}))).toBeNull();
    const options = buildOptions({
      over: bucket,
      askedYearly: [21600],
      debt: { interest_saved_cents: null, months: null, add_cents: 3000 },
    });
    // A stalled payoff plan has no debt candidate
    expect(options.map((o) => o.candidate)).toEqual([
      { kind: "over_plan", amounts_cents: [30], months: 1 },
      { kind: "subscription_check", amounts_cents: [21600], months: 12 },
    ]);
    expect(whatIfLink(options[1] as (typeof options)[number])).toBeNull();
  });
});
