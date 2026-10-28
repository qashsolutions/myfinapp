import { RULES_VERSION } from "@stackd/rules";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { DEFAULT_CATEGORIES } from "../../src/data/defaults.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-20T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  direction: "in" | "out",
  category: string | null,
  merchant: string,
  transfer = false,
): Entry {
  const stamp = `${date}T10:00:00.000Z`;
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant,
    clean_description: merchant,
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: transfer,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: stamp,
    updated_at: stamp,
  };
}

/** The mockup's October: needs $3,062 of $2,600, wants $1,326 of $1,560, save $400 of $1,040 on $5,200. */
async function seedOctober() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("e01", "2026-10-02", 240000, "in", "cat-paycheck", "Paycheck"),
    entry("e03", "2026-10-01", 165000, "out", "cat-rent", "Rent"),
    entry("e04", "2026-10-07", 4217, "out", "cat-groceries", "Corner Market"),
    entry("e05", "2026-10-14", 56983, "out", "cat-groceries", "Groceries"),
    entry("e12", "2026-10-07", 27500, "out", "cat-transport", "Transit"),
    entry("e11", "2026-10-04", 32500, "out", "cat-utilities", "Electric"),
    entry("e14", "2026-10-10", 20000, "out", "cat-insurance", "Insurance"),
    entry("e06", "2026-10-11", 45000, "out", "cat-fun", "Concert"),
    entry("e08", "2026-10-09", 36000, "out", "cat-shopping", "Shopping"),
    entry("e09", "2026-10-12", 2000, "in", "cat-shopping", "Store refund"),
    entry("e10", "2026-10-03", 28400, "out", "cat-dining", "Dining"),
    entry("e13", "2026-10-08", 15000, "out", "cat-subscriptions", "Streaming"),
    entry("e15", "2026-10-13", 10200, "out", "cat-other", "Misc"),
    entry("e07", "2026-10-05", 40000, "out", "cat-debt-payoff", "Loan payment"),
    entry("e16", "2026-10-06", 120000, "out", null, "Card payment", true),
    entry("e20", "2026-10-25", 99900, "out", "cat-fun", "Future concert"),
  ]);
  return db;
}

async function renderSignedIn(path: string) {
  installFakeApi({ session: readySession() });
  renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
}

describe("Budget", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets up take-home pay and a style, then shows 50/30/20 with over and left", async () => {
    const user = userEvent.setup();
    const db = await seedOctober();
    await renderSignedIn("/budget");
    expect(await screen.findByRole("heading", { name: "Your pay" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Paycheck"), "5200");
    await user.click(screen.getByRole("radio", { name: "Monthly" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Your pay a month" })).toHaveTextContent(
        "$5,200.00 a month",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Pick a budget style" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Needs $2,600.00")).toBeInTheDocument());
    expect(screen.getByText("Wants $1,560.00")).toBeInTheDocument();
    expect(screen.getByText("Save $1,040.00")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Needs · wants · save/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("October 2026 · $5,200.00 take-home · 50/30/20"),
    ).toBeInTheDocument();
    const needs = await screen.findByRole("region", { name: "Needs 50%" });
    await waitFor(() => expect(needs).toHaveTextContent("$3,062.00 of $2,600.00"));
    expect(needs).toHaveTextContent("$462.00 over");
    expect(within(needs).getByRole("progressbar", { name: "Needs spent" })).toHaveAttribute(
      "aria-valuetext",
      "$3,062.00 of $2,600.00",
    );
    expect(screen.getByRole("region", { name: "Wants 30%" })).toHaveTextContent(
      "$1,326.00 of $1,560.00",
    );
    expect(screen.getByRole("region", { name: "Wants 30%" })).toHaveTextContent("$234.00 left");
    expect(screen.getByRole("region", { name: "Save + pay down 20%" })).toHaveTextContent(
      "$400.00 of $1,040.00",
    );
    expect(screen.getByRole("region", { name: "Save + pay down 20%" })).toHaveTextContent(
      "$640.00 left",
    );
    const insight = await screen.findByRole("region", { name: "Needs are $462.00 over plan" });
    expect(insight).toHaveTextContent(
      "Rent alone is 32% of take-home. That's common. Your split is yours to change",
    );

    expect(await db.budgets.count()).toBe(1);
    expect((await db.settings.get("pay"))?.value).toMatchObject({
      amount_cents: 520000,
      frequency: "monthly",
      monthly_cents: 520000,
    });
    const stored = await db.computed_results.get("budget_summary:2026-10-01");
    expect(stored).toMatchObject({ kind: "budget_summary", rules_version: RULES_VERSION });
  });

  it("your own split: 50/30/20 is where it starts, the person sets 60/25/15", async () => {
    const user = userEvent.setup();
    const db = await seedOctober();
    await renderSignedIn("/budget");
    await user.type(await screen.findByLabelText("Paycheck"), "5200");
    await user.click(screen.getByRole("radio", { name: "Monthly" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Pick a budget style" });
    expect(screen.getByLabelText("Needs, percent of pay")).toHaveValue("50");
    await user.clear(screen.getByLabelText("Needs, percent of pay"));
    await user.type(screen.getByLabelText("Needs, percent of pay"), "60");
    // 60 + 30 + 20 = 110: said plainly, and Continue asks to fix it
    expect(screen.getByText("Adds up to 110%. Make it 100%.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("add up to 100%");
    await user.clear(screen.getByLabelText("Wants, percent of pay"));
    await user.type(screen.getByLabelText("Wants, percent of pay"), "25");
    await user.clear(screen.getByLabelText("Save, percent of pay"));
    await user.type(screen.getByLabelText("Save, percent of pay"), "15");
    // 5,200 × 60% = 3,120; × 25% = 1,300; × 15% = 780
    await waitFor(() => expect(screen.getByText("Needs $3,120.00")).toBeInTheDocument());
    expect(screen.getByText("Save $780.00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("October 2026 · $5,200.00 take-home · 60/25/15"),
    ).toBeInTheDocument();
    const needs = await screen.findByRole("region", { name: "Needs 60%" });
    await waitFor(() => expect(needs).toHaveTextContent("of $3,120.00"));
    expect((await db.budgets.toArray())[0]?.split_bps).toEqual({
      need: 6000,
      want: 2500,
      save: 1500,
    });
  });

  it("turns a paycheck and its frequency into a monthly figure through the engine", async () => {
    const user = userEvent.setup();
    await seedOctober();
    await renderSignedIn("/budget");
    await user.type(await screen.findByLabelText("Paycheck"), "2,600");
    await user.click(screen.getByRole("radio", { name: "Every 2 weeks" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Your pay a month" })).toHaveTextContent(
        "$5,633.33 a month",
      ),
    );
    await user.click(screen.getByRole("radio", { name: "Weekly" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Your pay a month" })).toHaveTextContent(
        "$11,266.67 a month",
      ),
    );
  });

  it("editing a saved paycheck keeps what the person types (invariant 18)", async () => {
    // The saved pay fills the form once; recomputing the monthly figure must never reload it
    // over the new amount being typed.
    const user = userEvent.setup();
    await seedOctober();
    await openDb("u1").settings.put({
      key: "pay",
      value: {
        amount_cents: 260000,
        frequency: "biweekly",
        next_payday: null,
        monthly_cents: 563333,
      },
      updated_at: "2026-10-01T00:00:00Z",
    });
    await renderSignedIn("/budget");
    const amount = await screen.findByLabelText("Paycheck");
    await waitFor(() => expect(amount).toHaveValue("2600.00"));
    await user.clear(amount);
    await user.type(amount, "3,000");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Your pay a month" })).toHaveTextContent(
        "$6,500.00 a month",
      ),
    );
    expect(amount).toHaveValue("3,000");
  });

  it("zero-based: every dollar gets a job, and over-assigning shows", async () => {
    const user = userEvent.setup();
    const db = await seedOctober();
    await createBudget(db, "2026-10", "50_30_20", 520000);
    await renderSignedIn("/budget");
    await screen.findByText("October 2026 · $5,200.00 take-home · 50/30/20");
    await user.click(screen.getByRole("button", { name: "Change budget style" }));
    await user.click(await screen.findByRole("radio", { name: /Zero-based/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("October 2026 · $5,200.00 take-home · Zero-based"),
    ).toBeInTheDocument();
    const left = await screen.findByRole("region", { name: "Left to assign" });
    await waitFor(() => expect(left).toHaveTextContent("$5,200.00"));
    const planned = screen.getByRole("region", { name: "Planned by category" });
    expect(within(planned).getAllByRole("textbox")).toHaveLength(12);
    expect(planned).toHaveTextContent("$1,650.00 spent");
    await user.type(within(planned).getByRole("textbox", { name: "Rent planned" }), "1650{Enter}");
    await waitFor(() => expect(left).toHaveTextContent("$3,550.00"));
    await user.type(
      within(planned).getByRole("textbox", { name: "Groceries planned" }),
      "10000{Enter}",
    );
    await waitFor(() => expect(left).toHaveTextContent("Over-assigned"));
    expect(left).toHaveTextContent("$6,450.00");
    const lines = await db.budget_lines.toArray();
    expect(lines.find((l) => l.category_id === "cat-rent")?.planned_cents).toBe(165000);
    expect(lines).toHaveLength(12);
  });

  it("zero-based, complete: start from last month, cover an over line, move money, assign what's left (October 23, 2026)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("s1", "2026-09-05", 30000, "out", "cat-dining", "Bistro"),
      entry("s2", "2026-09-10", 120000, "out", "cat-rent", "Rent"),
      entry("o1", "2026-10-03", 45000, "out", "cat-dining", "Bistro"),
    ]);
    await createBudget(
      db,
      "2026-10",
      "zero_based",
      200000,
      DEFAULT_CATEGORIES.filter((c) => c.kind === "expense").map((c) => ({
        category_id: c.id,
        planned_cents: 0,
      })),
    );
    await renderSignedIn("/budget");
    const left = await screen.findByRole("region", { name: "Left to assign" });
    const planned = screen.getByRole("region", { name: "Planned by category" });
    // A fresh plan: nothing planned is not "over".
    await waitFor(() => expect(planned).toHaveTextContent("$450.00 spent · nothing planned yet"));
    expect(within(planned).queryByRole("button", { name: "Cover it" })).toBeNull();

    // Start from last month: Dining 300, Rent 1,200.
    await user.click(within(left).getByRole("button", { name: "Start from last month" }));
    await waitFor(() => expect(left).toHaveTextContent("$500.00"));
    expect(planned).toHaveTextContent("$450.00 of $300.00 · $150.00 over");

    // Dining is over: Cover it moves the gap from another line.
    await user.click(within(planned).getByRole("button", { name: "Cover it" }));
    const move = await screen.findByRole("dialog", { name: "Move money" });
    expect(within(move).getByLabelText("Amount")).toHaveValue("150.00");
    await user.click(
      within(within(move).getByRole("group", { name: "From" })).getByRole("radio", {
        name: /^Rent/,
      }),
    );
    await user.click(within(move).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(planned).toHaveTextContent("$450.00 of $450.00 · $0.00 left"));
    expect(left).toHaveTextContent("$500.00"); // moving never changes what's left to assign

    // Assign what's left: the $500 goes to Savings.
    await user.click(within(left).getByRole("button", { name: "Assign what's left" }));
    const assign = await screen.findByRole("dialog", { name: "Assign what's left" });
    await user.click(within(assign).getByRole("button", { name: "Savings" }));
    await waitFor(() => expect(left).toHaveTextContent("Every dollar has a job."));
    const lines = await db.budget_lines.toArray();
    const plan = (id: string) => lines.find((l) => l.category_id === id)?.planned_cents;
    expect([plan("cat-dining"), plan("cat-rent"), plan("cat-savings")]).toEqual([
      45000, 105000, 50000,
    ]);
  });

  it("carries the latest budget into the current month, and the Home tile shows its status", async () => {
    const user = userEvent.setup();
    const db = await seedOctober();
    await createBudget(db, "2026-09", "50_30_20", 520000);
    await renderSignedIn("/budget");
    expect(
      await screen.findByText("October 2026 · $5,200.00 take-home · 50/30/20"),
    ).toBeInTheDocument();
    expect(await db.budgets.count()).toBe(2);
    expect((await db.budgets.where("month").equals("2026-10").first())?.take_home_cents).toBe(
      520000,
    );
    await user.click(screen.getByRole("link", { name: "Home" }));
    const tile = await screen.findByRole("link", { name: "Open Budget" });
    await waitFor(() => expect(tile).toHaveTextContent("Budget · 50/30/20"));
    await waitFor(() => expect(tile).toHaveTextContent("Needs $462.00 over"));
  });
});
