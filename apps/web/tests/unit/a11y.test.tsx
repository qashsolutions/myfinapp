/**
 * WCAG checks over every screen with axe-core (docs/spec.md "Accessibility"). jsdom has no
 * layout, so colour contrast is the token guard's job (`pnpm contrast`); everything axe can
 * judge from the DOM (names, roles, labels, landmarks, headings, lists, ARIA) must pass.
 */

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import { createGoal } from "../../src/features/goals/useGoals.ts";
import { forgetKept, rememberKept } from "../../src/lib/keptAccount.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  merchant: string,
  direction: "in" | "out",
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: direction === "out" ? "cat-shopping" : "cat-paycheck",
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
  };
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("e1", "2026-10-02", 520000, "Paycheck", "in"),
    entry("e2", "2026-10-03", 12050, "Corner Market", "out"),
    entry("e3", "2026-10-05", 8900, "Fuel", "out"),
  ]);
  await createGoal(db, {
    kind: "save",
    title: "Travel",
    target_cents: 200000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: "2027-04-01",
    baseline_cents: null,
    group_id: null,
  });
}

async function check(path: string, ready: () => Promise<unknown>) {
  const { container } = renderApp(path);
  await ready();
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
  expect(summary, `${path}\n${summary.join("\n")}`).toEqual([]);
}

const signedIn: Array<[string, string | RegExp]> = [
  ["/", "Kept this month, open Money in & out"],
  ["/money", "Money in & out"],
  ["/budget", "Budget"],
  ["/goals", "Goals"],
  ["/goals/new", "New goal"],
  ["/forecast", "Next 30 days"],
  ["/bills", "Bills & debt"],
  ["/emergency", "Emergency fund"],
  ["/insights", "Insights"],
  ["/insights/spending", "Biggest & most often"],
  ["/insights/fixed-flexible", "Fixed vs flexible"],
  ["/subscriptions", "Subscriptions"],
  ["/credit-habits", "Credit habits"],
  ["/insights/later", "Later"],
  ["/what-if", "What if"],
  ["/month-review", "Your month"],
  ["/review", "Sort your spending"],
  ["/recap", "Your week"],
  ["/add", "Add entry"],
  ["/money?view=transactions", "Money in & out"],
  ["/import", "Import a statement"],
  ["/me", "Me"],
  ["/me/security", "Security & backup"],
  ["/link", "Link a device"],
  ["/net-worth", "Net worth"],
  ["/tags", "Tags"],
  ["/setup", "Make Qash yours"],
  ["/me/plan", "Your plan"],
  ["/me/household", "Couples & household"],
  ["/me/notifications", "Alerts"],
  ["/me/account", "Account & plan"],
  ["/me/data", "Money & data"],
  ["/me/groups", "Groups & household"],
  ["/me/look", "Look & feel"],
  ["/me/help", "Help & legal"],
  ["/me/accounts", "Accounts & imports"],
  ["/me/categories", "Categories"],
  ["/me/subscription-words", "Subscription words"],
  ["/me/linking", "Linked banks & cards"],
  ["/me/linking/done?session=x", "Linking"],
];

describe("accessibility (axe-core)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(signedIn)("%s has no axe violations", async (path, heading) => {
    await seed();
    installFakeApi({
      session: readySession({
        user: { id: "u1", email: "maya@example.com", display_name: "Maya R.", look: "modern" },
      }),
    });
    await check(path, async () => {
      if (path === "/") await screen.findByRole("link", { name: heading as string });
      else await screen.findByRole("heading", { level: 1, name: heading });
      await screen.findByRole("navigation", { name: "Primary" });
    });
  });

  it.each([
    ["/welcome", "Keep more of what you earn."],
    ["/signin", /Sign in|email/i],
    ["/signin/phone", "Sign in with your phone"],
    ["/link?code=ABCD-EFGH", "Approve in the Qash app"],
    ["/install", "Install Qash"],
  ])("%s (signed out) has no axe violations", async (path, heading) => {
    installFakeApi({});
    await check(path, async () => {
      await screen.findByRole("heading", { level: 1, name: heading });
    });
  });

  // Adjust sheets (October 29, 2026): `?adjust=1` opens them; the sheet is a portal on the body.
  it.each([
    ["/month-review?adjust=1", "Adjust Your month"],
    ["/insights/fixed-flexible?adjust=1", "Adjust fixed vs flexible"],
  ])("%s (the Adjust sheet) has no axe violations", async (path, title) => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp(path);
    const sheet = await screen.findByRole("dialog", { name: title });
    await within(sheet).findByRole("button", { name: "Done" });
    const results = await axe.run(sheet, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  // One screen per test: two renders in one test put two <main> landmarks on the page.
  it("/start (pick a free trial) has no axe violations", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free" };
    await check("/start", async () => {
      await screen.findByRole("heading", { level: 1, name: "Try Qash free" });
      await screen.findAllByText("Free for 3 days");
    });
    resetEntitlements();
  });

  it("/start (welcome back, the trial already used) has no axe violations", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free", trial_used: true };
    await check("/start", async () => {
      await screen.findByRole("heading", { level: 1, name: "Welcome back" });
    });
    resetEntitlements();
  });

  it("/kept (a plan ended, the data kept on the phone) has no axe violations", async () => {
    rememberKept({ user_id: "u1", closed_at: "2026-10-20T00:00:00Z", email_hash: null });
    installFakeApi({});
    await check("/kept", async () => {
      await screen.findByRole("heading", { level: 1, name: "Your data is safe here" });
    });
    forgetKept();
  });

  it("an ended plan (/me/plan locked) has no axe violations", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "lapsed", plan: "free", delete_at: "2026-10-20T00:00:00Z" };
    await check("/me/plan", async () => {
      await screen.findByText("Your trial has wrapped up");
    });
    resetEntitlements();
  });

  it("/subscriptions with its Adjust and kind sheets open has no axe violations", async () => {
    await seed();
    await openDb("u1").recurring_series.add({
      id: "s-net",
      payee: "NETFLIX",
      label: "Netflix",
      kind: "bill",
      expected_cents: 1549,
      interval: "monthly",
      next_date: "2026-10-20",
      status: "confirmed",
      source: "detected",
      account_id: null,
      subscription: true,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    const sheets = async (): Promise<string[]> => {
      const results = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      return results.violations.map((v) => `${v.id}: ${v.help}`);
    };
    renderApp("/subscriptions");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await screen.findByRole("list", { name: "By kind" });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    await screen.findByRole("dialog", { name: "Adjust subscription check" });
    expect(await sheets()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: /Change the kind of Netflix/ }));
    const picker = await screen.findByRole("dialog", { name: "What kind is Netflix?" });
    // With "Also for future charges like this" on, the word box shows
    await user.click(within(picker).getByRole("switch", { name: /Also for future charges/ }));
    expect(await sheets()).toEqual([]);
    await user.click(within(picker).getByRole("button", { name: "+ New kind" }));
    await screen.findByRole("dialog", { name: "New kind" });
    expect(await sheets()).toEqual([]);
  });

  it("/me/subscription-words with a word and a kind, and its sheets open, has no axe violations", async () => {
    await seed();
    const db = openDb("u1");
    await db.own_subscription_kinds.add({
      id: "own-k1",
      label: "Toys",
      created_at: "2026-10-29T00:00:00Z",
      updated_at: "2026-10-29T00:00:00Z",
    });
    await db.own_subscription_words.add({
      id: "w1",
      match: "LEGO",
      kind: "own-k1",
      created_at: "2026-10-29T00:00:00Z",
      updated_at: "2026-10-29T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/me/subscription-words");
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await screen.findByRole("list", { name: "Your words" });
    await checkBody("/me/subscription-words");
    await user.click(screen.getByRole("button", { name: "Add word" }));
    await screen.findByRole("dialog", { name: "Add a word" });
    await checkBody("/me/subscription-words · Add a word");
    await user.keyboard("{Escape}");
    await user.click(within(screen.getByRole("list", { name: "Your kinds" })).getByText("Toys"));
    await screen.findByRole("dialog", { name: "Edit Toys" });
    await checkBody("/me/subscription-words · Edit Toys");
  });

  it("/welcome for a returning person (Welcome back) has no axe violations", async () => {
    localStorage.setItem(
      "stackd.last_account",
      JSON.stringify({ masked: "ma•••@example.com", initial: "M", name: "Maya" }),
    );
    installFakeApi({});
    await check("/welcome", async () => {
      await screen.findByRole("heading", { level: 1, name: "Welcome back, Maya." });
    });
    localStorage.removeItem("stackd.last_account");
  });
});

/** The page and any open sheet (sheets are portalled to the body). */
async function checkBody(what: string) {
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
  expect(summary, `${what}\n${summary.join("\n")}`).toEqual([]);
}

// The Adjust sheets and the pictures behind them (October 29, 2026).
describe("accessibility of the Adjust sheets (axe-core)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => vi.useRealTimers());

  it("Adjust payoff plan, over the payoff timeline", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.debts.bulkAdd([
      {
        id: "a",
        label: "Card",
        balance_cents: 20000,
        apr_bps: 2400,
        min_payment_cents: 2000,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "b",
        label: "Loan",
        balance_cents: 10000,
        apr_bps: 1200,
        min_payment_cents: 2000,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/bills?tab=debt");
    const plan = await screen.findByRole("region", { name: "Payoff plan" });
    await within(plan).findByRole("img", { name: /Total balance falls/ });
    await checkBody("Debt payoff");
    await user.click(within(plan).getByRole("button", { name: "Adjust payoff plan" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust payoff plan" });
    await within(sheet).findByRole("img", { name: /Total balance falls/ });
    await checkBody("Adjust payoff plan");
  });

  it("Adjust bills and regular spending on Bills", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    const rows = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"].map((date, i) => ({
      id: `tj${i}`,
      date,
      amount_cents: 8400,
      direction: "out" as const,
      merchant: "TRADER JOE'S",
      clean_description: "TRADER JOE'S",
      raw_description: null,
      category_id: "cat-groceries",
      account_id: "acct-cash",
      source: "import" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: `${date}T00:00:00Z`,
      updated_at: `${date}T00:00:00Z`,
    }));
    await db.entries.bulkAdd(rows);
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await screen.findByRole("region", { name: "Regular spending, not bills" });
    await checkBody("Bills with regular spending");
    await user.click(screen.getByRole("button", { name: "Adjust bills" }));
    await screen.findByRole("dialog", { name: "Adjust bills" });
    await checkBody("Adjust bills");
  });

  it("Adjust credit habits, over the dot strip", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.accounts.put({
      id: "acct-visa",
      label: "Visa",
      type: "credit_card",
      last4: "4242",
      institution: null,
      currency: "USD",
      created_at: "2026-07-01T00:00:00Z",
      due_day: 15,
    });
    await db.entries.bulkAdd([
      { ...entry("c1", "2026-08-03", 8000, "Grocer", "out"), account_id: "acct-visa" },
      { ...entry("c2", "2026-08-14", 5000, "Payment", "in"), account_id: "acct-visa" },
    ]);
    await db.balance_anchors.add({
      id: "anc-visa",
      account_id: "acct-visa",
      as_of: "2026-08-01",
      balance_cents: 0,
      source: "user",
      created_at: "2026-08-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/credit-habits");
    await screen.findByRole("img", { name: /^Due dates:/ });
    await checkBody("Credit habits");
    await user.click(screen.getByRole("button", { name: "Adjust credit habits" }));
    await screen.findByRole("dialog", { name: "Adjust credit habits" });
    await checkBody("Adjust credit habits");
  });

  it("Adjust budget alerts, over the marked bars", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add({
      ...entry("b1", "2026-10-05", 18500, "Bistro", "out"),
      category_id: "cat-groceries",
    });
    await createBudget(db, "2026-10", "zero_based", 400000, [
      { category_id: "cat-groceries", planned_cents: 20000 },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    await screen.findByRole("region", { name: "Planned by category" });
    await checkBody("Budget");
    await user.click(screen.getByRole("button", { name: "Adjust budget alerts" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust budget alerts" });
    await within(sheet).findByRole("switch", { name: "Budget alert" });
    await checkBody("Adjust budget alerts");
  });
});
