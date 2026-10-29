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
  linesOver,
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

  it("never sets October against two days of September, in words or bars (invariant 51)", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      // The statement starts Sep 29: September is only two days here
      entry("pay-sep", "2026-09-29", 300000, "in", "cat-paycheck"),
      entry("dining-sep", "2026-09-30", 7000, "out", "cat-dining"),
      entry("pay-oct", "2026-10-01", 300000, "in", "cat-paycheck"),
      entry("rent-oct", "2026-10-01", 150000, "out", "cat-rent"),
      entry("dining-oct", "2026-10-10", 31000, "out", "cat-dining"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    const how = await screen.findByRole("region", { name: "How it went" });
    await waitFor(() => expect(how).toHaveTextContent("40% of what came in"));
    // No month before to compare with: Kept, not Down against September's 98%
    expect(how).toHaveTextContent("Kept");
    expect(how).not.toHaveTextContent("Down");
    expect(how).not.toHaveTextContent("September 2026");
    // October alone: no kept-rate bars with a partial September in them
    expect(within(how).queryByRole("img")).toBeNull();
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
    await waitFor(() => expect(how).toHaveTextContent("40% of what came in"));
    // 40% in October against 67% in September
    expect(how).toHaveTextContent("Down");
    // Kept is the hero; in against out as bars; the kept rate by month (months with nothing
    // before September are left off), October drawn full strength
    expect(how.querySelector(".sk-card__hero")).toHaveTextContent("$1,190.00 kept");
    expect(how).toHaveTextContent("In$3,000.00");
    expect(how).toHaveTextContent("Out$1,810.00");
    expect(how).toHaveTextContent("September 2026: 67% kept");
    expect(within(how).getByRole("img")).toHaveAccessibleName(
      "Kept rate by month: September 2026 67%, October 2026 40%",
    );
    expect(how.querySelectorAll(".kept-trend__bar--on")).toHaveLength(1);

    const budget = screen.getByRole("region", { name: "Budget" });
    await waitFor(() => expect(budget).toHaveTextContent("1 line over · Dining $120.00 over"));
    expect(budget).toHaveTextContent("Over");
    // The same marked bar as Budget: the plan's end is a tick on the track
    const dining = within(budget).getByRole("progressbar", { name: "Dining spent of planned" });
    expect(dining.getAttribute("aria-valuetext")).toMatch(/^\$310\.00 of \$190\.00 · /);
    expect(budget.querySelectorAll(".sk-progress__mark").length).toBeGreaterThan(0);

    // Fixed vs flexible inside the review: the bar and the room line only; the word and the
    // kept rate are How it went's, said once.
    const fixed = await screen.findByRole("region", { name: "Fixed vs flexible" });
    await waitFor(() => expect(fixed).toHaveTextContent(/^Fixed vs flexibleFixed \$/));
    expect(fixed).not.toHaveTextContent("kept");
    expect(fixed.querySelector(".word")).toBeNull();

    const jars = await screen.findByRole("region", { name: "Jars" });
    await waitFor(() => expect(jars).toHaveTextContent("Reached"));
    expect(jars).toHaveTextContent("$500.00 new money into 1 jar");
    expect(jars).toHaveTextContent("Bike reached its target.");

    // Nothing to say: no debts, no cards, no subscriptions
    expect(screen.queryByRole("region", { name: "Debt" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Subscriptions" })).toBeNull();

    const change = await screen.findByRole("region", { name: "One change" });
    await waitFor(() =>
      expect(change).toHaveTextContent("Dining $120 less a month → $1,440 a year"),
    );
    expect(change).toHaveTextContent("not advice");
    const year = within(change).getByRole("list", { name: "A month against a year" });
    expect(year).toHaveTextContent("A month$120");
    expect(year).toHaveTextContent("A year$1,440");
    // Each jar with new money: a ring of how far along it was at the month's end
    expect(jars).toHaveTextContent("Bike+$500.00 new100% of its target");
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
      expect(screen.getByRole("region", { name: "How it went" })).toHaveTextContent(
        "67% of what came in",
      ),
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

  it("Adjust: the person picks how long Home shows the card, or switches it off", async () => {
    vi.setSystemTime(new Date("2026-11-10T12:00:00"));
    const db = await seedMonths();
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    await screen.findByRole("region", { name: "How it went" });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust Your month" });
    // 7 days until they pick (signed off October 29, 2026)
    expect(within(sheet).getByRole("radio", { name: "7 days" })).toBeChecked();
    await user.click(within(sheet).getByRole("radio", { name: "14 days" }));
    await waitFor(async () =>
      expect((await db.settings.get("month_review.show_days"))?.value).toBe(14),
    );
    // Their own number, 1 to 28
    const own = within(sheet).getByRole("textbox", { name: "Your own number of days" });
    await user.type(own, "40");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("from 1 to 28");
    await user.clear(own);
    await user.type(own, "12");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    await waitFor(async () =>
      expect((await db.settings.get("month_review.show_days"))?.value).toBe(12),
    );
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    // The 10th is inside their 12 days: Home shows the card
    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("link", { name: /^Home/ }));
    expect(
      await screen.findByRole("link", { name: /Your month: October 2026: \$1,190.00 kept/ }),
    ).toBeVisible();
  });

  it("Adjust: off keeps the card off Home in the first days too", async () => {
    const db = await seedMonths();
    await db.settings.put({ key: "month_review.home_card", value: false, updated_at: STAMP });
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("link", { name: /Kept this month/ });
    expect(screen.queryByRole("link", { name: /Your month:/ })).toBeNull();
  });

  it("the sections follow the person's own order, and a hidden one is left out", async () => {
    const db = await seedMonths();
    await db.settings.put({
      key: "month_review.layout",
      value: { order: ["change", "budget"], hidden: ["fixed"] },
      updated_at: STAMP,
    });
    installFakeApi({ session: readySession() });
    renderApp("/month-review");
    const change = await screen.findByRole("region", { name: "One change" });
    const budget = await screen.findByRole("region", { name: "Budget" });
    expect(change.compareDocumentPosition(budget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Fixed vs flexible" })).toBeNull();
    expect(screen.getByRole("button", { name: "Customize Your month" })).toBeVisible();
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
        "$50 more a month on debts → about $4.68 less interest a year",
      ),
    );
    expect(within(change).getByRole("link", { name: "Try it in What if" })).toHaveAttribute(
      "href",
      "/what-if?lever=debts&amount=5000",
    );
    const debt = await screen.findByRole("region", { name: "Debt" });
    // The month leads as the value; "Debt-free" is the line, never a green word about today.
    await waitFor(() => expect(debt).toHaveTextContent(/[A-Z][a-z]{2} \d{4}/));
    expect(debt).toHaveTextContent("Debt-free at this pace");
    const word = debt.querySelector(".word");
    expect(word).toHaveTextContent(/^Mar 2027$/);
    expect(word).toHaveClass("word--plain");
    // The balance on today's plan as a short line down to the debt-free month
    expect(within(debt).getByRole("img")).toHaveAccessibleName(
      "Debt balance going down to nothing by Mar 2027",
    );
    // The one change's before and after: the debt-free month moving earlier
    const sooner = within(change).getByRole("list", {
      name: "Debt-free date, now and with the extra",
    });
    expect(sooner).toHaveTextContent("NowMar 2027");
    expect(sooner).toHaveTextContent("+$50 a monthFeb 2027");
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
        "$50 more a month on debts → about $10.41 less interest a year",
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
    await waitFor(() => expect(change).toHaveTextContent("Check 1 subscription → $216 a year"));
    await user.click(screen.getByRole("button", { name: "‹ Earlier" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "How it went" })).toHaveTextContent(
        "67% of what came in",
      ),
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
            // Nothing planned is a line still waiting for its job, never "over" (as on Budget
            // and in the budget alert); nor is putting more aside on a save line.
            { category_id: "d", bucket: "need", planned_cents: 0, spent_cents: 5000 },
            { category_id: "e", bucket: "save", planned_cents: 100, spent_cents: 9000 },
          ],
        }),
      ),
    ).toEqual({ category_id: "a", bucket: null, over_cents: 50, whatif_category: "a" });
    expect(
      linesOver(
        summary({
          categories: [
            { category_id: "d", bucket: "need", planned_cents: 0, spent_cents: 5000 },
            { category_id: "e", bucket: "save", planned_cents: 100, spent_cents: 9000 },
          ],
        }),
      ),
    ).toEqual([]);
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
