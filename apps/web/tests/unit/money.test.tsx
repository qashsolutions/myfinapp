import { RULES_VERSION } from "@stackd/rules";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { ENTRIES_PATH } from "../../src/features/entries/paths.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  direction: "in" | "out",
  category: string | null,
  account: string,
  transfer = false,
  merchant?: string,
): Entry {
  const stamp = `${date}T10:00:00.000Z`;
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant: merchant ?? id,
    clean_description: merchant ?? id,
    raw_description: null,
    category_id: category,
    account_id: account,
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

/** The October sample from the mockup (and the cashflow golden): In $5,200, Out $4,788, Kept $412. */
async function seedOctober() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.add({
    id: "acct-card",
    label: "Rewards card",
    type: "credit_card",
    last4: "1173",
    institution: null,
    currency: "USD",
    created_at: "2026-09-01T00:00:00Z",
  });
  await db.entries.bulkAdd([
    entry("e01", "2026-10-02", 240000, "in", "cat-paycheck", "acct-cash", false, "Paycheck"),
    entry("e02", "2026-10-16", 280000, "in", "cat-paycheck", "acct-cash", false, "Paycheck"),
    entry("e03", "2026-10-01", 165000, "out", "cat-rent", "acct-cash", false, "Rent"),
    entry("e04", "2026-10-07", 4217, "out", "cat-groceries", "acct-card", false, "Corner Market"),
    entry("e05", "2026-10-14", 56983, "out", "cat-groceries", "acct-card", false, "Groceries"),
    entry("e06", "2026-10-11", 45000, "out", "cat-fun", "acct-card", false, "Concert"),
    entry("e07", "2026-10-05", 40000, "out", "cat-debt-payoff", "acct-cash", false, "Loan payment"),
    entry("e08", "2026-10-09", 36000, "out", "cat-shopping", "acct-card", false, "Shopping"),
    entry("e09", "2026-10-12", 2000, "in", "cat-shopping", "acct-card", false, "Store refund"),
    entry("e10", "2026-10-03", 28400, "out", "cat-dining", "acct-card", false, "Dining"),
    entry("e11", "2026-10-04", 32000, "out", "cat-utilities", "acct-cash", false, "Electric"),
    entry("e12", "2026-10-07", 27500, "out", "cat-transport", "acct-card", false, "Transit"),
    entry("e13", "2026-10-08", 15000, "out", "cat-subscriptions", "acct-card", false, "Streaming"),
    entry("e14", "2026-10-10", 20000, "out", "cat-insurance", "acct-cash", false, "Insurance"),
    entry("e15", "2026-10-13", 10700, "out", "cat-other", "acct-card", false, "Misc"),
    entry("e16", "2026-10-06", 120000, "out", null, "acct-cash", true, "Card payment"),
    entry("e17", "2026-10-06", 120000, "in", null, "acct-card", true, "Payment - thank you"),
    entry("s01", "2026-09-01", 100000, "in", "cat-paycheck", "acct-cash", false, "Paycheck"),
    entry("s02", "2026-09-05", 68400, "out", "cat-rent", "acct-cash", false, "Rent"),
  ]);
  return db;
}

async function renderSignedIn(path: string) {
  installFakeApi({ session: readySession() });
  renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
}

describe("Money in & out", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows In, Out and Kept for the month from the engine, with transfers excluded and last month compared", async () => {
    const db = await seedOctober();
    await renderSignedIn("/money");
    const stats = await screen.findByRole("group", { name: "This month" });
    await waitFor(() => expect(within(stats).getByText("$412.00")).toBeInTheDocument());
    expect(within(stats).getByText("+$5,200.00")).toBeInTheDocument();
    expect(within(stats).getByText("−$4,788.00")).toBeInTheDocument();
    expect(screen.getByText(/vs September: you kept/)).toHaveTextContent(
      "vs September: you kept $96.00 more · transfers excluded ($1,200.00)",
    );
    const byCategory = screen.getByRole("region", { name: "By category" });
    expect(within(byCategory).getByText("Rent")).toBeInTheDocument();
    expect(within(byCategory).getByText("$1,650.00")).toBeInTheDocument();
    expect(within(byCategory).getByText("Shopping")).toBeInTheDocument();
    expect(within(byCategory).getByText("$340.00")).toBeInTheDocument(); // refund netted
    expect(within(byCategory).getByText("5 more categories")).toBeInTheDocument();
    expect(within(byCategory).getByText("$1,016.00")).toBeInTheDocument(); // dining, transport, insurance, subscriptions, other
    const stored = await db.computed_results.get("month_totals:2026-10-01");
    expect(stored).toMatchObject({ kind: "month_totals", rules_version: RULES_VERSION });
    expect(stored?.payload).toMatchObject({ net_cents: 41200 });
  });

  it("never compares with a month the data only partly covers: two days of September (invariant 51)", async () => {
    const db = await seedOctober();
    // The statement starts Sep 29: September's two days are its own numbers, never "September".
    await db.entries.bulkUpdate([
      { key: "s01", changes: { date: "2026-09-29" } },
      { key: "s02", changes: { date: "2026-09-30" } },
    ]);
    await renderSignedIn("/money");
    const stats = await screen.findByRole("group", { name: "This month" });
    await waitFor(() => expect(within(stats).getByText("$412.00")).toBeInTheDocument());
    expect(
      await screen.findByText(/First full month here, nothing to compare yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/vs September/)).not.toBeInTheDocument();
  });

  it("lists transactions, and marking one as a transfer changes the totals", async () => {
    const user = userEvent.setup();
    await seedOctober();
    await renderSignedIn("/money");
    await screen.findByText("$412.00");
    await user.click(screen.getByRole("radio", { name: "Transactions" }));
    // Grouped by day, as the old Entries screen was (October 23, 2026).
    const list = screen.getByRole("region", { name: "Transactions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(17);
    expect(within(list).getByRole("region", { name: "Oct 6" })).toHaveTextContent(
      /Cash · Transfer/,
    );
    await user.click(within(list).getByRole("button", { name: /^Rent/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Edit entry" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("switch", { name: "Transfer between my accounts" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });
    await user.click(screen.getByRole("link", { name: "Home" }));
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() => expect(hero).toHaveTextContent("$2,062.00"));
    expect(hero).toHaveTextContent("Got $5,200.00 · Spent $3,138.00 · Kept $2,062.00");
    expect(hero).toHaveTextContent("$2,062.00 kept");
    await waitFor(() => expect(hero).toHaveTextContent("You spent less than you earned"));
  });

  it("splits an entry into two parts that still add up", async () => {
    const user = userEvent.setup();
    const db = await seedOctober();
    // A linked entry: the bank's id stays on the entry, never on the split part
    await db.entries.update("e04", { provider_txn_id: "t-e04", pending: false });
    await renderSignedIn("/entries/e04");
    await screen.findByRole("heading", { level: 1, name: "Edit entry" });
    await waitFor(() => expect(screen.getByLabelText("Merchant")).toHaveValue("Corner Market"));
    await user.click(screen.getByRole("button", { name: "Split this entry" }));
    await user.type(screen.getByLabelText("Split off amount"), "10.00");
    const splitChips = screen.getByRole("group", { name: "Category for the split part" });
    await user.click(within(splitChips).getByRole("radio", { name: "Dining" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });
    const parts = (await db.entries.toArray()).filter((e) => e.merchant === "Corner Market");
    expect(parts.map((p) => [p.amount_cents, p.category_id, p.split_parent_id]).sort()).toEqual([
      [1000, "cat-dining", "e04"],
      [3217, "cat-groceries", null],
    ]);
    expect(parts.reduce((s, p) => s + p.amount_cents, 0)).toBe(4217);
    expect(parts.map((p) => [p.split_parent_id, p.provider_txn_id ?? null]).sort()).toEqual([
      [null, "t-e04"],
      ["e04", null],
    ]);
  });

  it("moves between months and the empty month says so", async () => {
    const user = userEvent.setup();
    await seedOctober();
    await renderSignedIn("/money");
    await screen.findByText("$412.00");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await screen.findByText("September 2026");
    await waitFor(() => expect(screen.getByText("+$1,000.00")).toBeInTheDocument());
    expect(screen.getByText(/No entries in August to compare/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await screen.findByText("October 2026");
    await waitFor(() => expect(screen.getByText("$412.00")).toBeInTheDocument());
  });

  it("never steps past this month, so no range ends before it starts", async () => {
    const user = userEvent.setup();
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent) => rejections.push(e.reason);
    window.addEventListener("unhandledrejection", onRejection);
    try {
      await seedOctober();
      await renderSignedIn("/money");
      await screen.findByText("$412.00");
      expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Next month" }));
      expect(screen.getByText("October 2026")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Previous month" }));
      await screen.findByText("September 2026");
      expect(screen.getByRole("button", { name: "Next month" })).toBeEnabled();
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });

  it("Home's hero is the month's Kept number and opens Money in & out", async () => {
    const user = userEvent.setup();
    await seedOctober();
    await renderSignedIn("/");
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() => expect(hero).toHaveTextContent("$412.00"));
    await user.click(hero);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();
  });

  // Your entries are always reachable (invariant: every "your entries" link lands on a list).
  it("opens your entries even when the Categories and transactions card is hidden", async () => {
    const db = await seedOctober();
    await db.settings.put({
      key: "money.layout",
      value: { order: ["summary", "weeks", "details"], hidden: ["details"] },
      updated_at: "2026-10-10T10:00:00.000Z",
    });
    await renderSignedIn(ENTRIES_PATH);
    const list = await screen.findByRole("region", { name: "Transactions" });
    expect(within(list).getByRole("button", { name: /^Rent/ })).toBeInTheDocument();
  });

  it("opens your entries on the month even when a longer range was saved, and keeps that range", async () => {
    await seedOctober();
    localStorage.setItem("stackd.range.money", "Quarter");
    try {
      await renderSignedIn(ENTRIES_PATH);
      const list = await screen.findByRole("region", { name: "Transactions" });
      expect(within(list).getByRole("button", { name: /^Rent/ })).toBeInTheDocument();
      expect(localStorage.getItem("stackd.range.money")).toBe("Quarter");
    } finally {
      localStorage.removeItem("stackd.range.money");
    }
  });
});
