/**
 * WCAG checks over every screen with axe-core (docs/spec.md "Accessibility"). jsdom has no
 * layout, so colour contrast is the token guard's job (`pnpm contrast`); everything axe can
 * judge from the DOM (names, roles, labels, landmarks, headings, lists, ARIA) must pass.
 */

import { screen, within } from "@testing-library/react";
import axe from "axe-core";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
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
