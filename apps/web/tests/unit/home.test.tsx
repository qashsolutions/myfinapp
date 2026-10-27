import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { addGoalEvent, moveMoney } from "../../src/features/goals/useGoals.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  merchant: string,
  direction: "in" | "out" = "out",
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

async function seedPayAndBudget() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.settings.put({
    key: "pay",
    value: {
      amount_cents: 240000,
      frequency: "biweekly",
      next_payday: "2026-10-10",
      monthly_cents: 520000,
    },
    updated_at: "2026-10-01T00:00:00Z",
  });
  await db.budgets.add({
    id: "b-oct",
    month: "2026-10",
    method: "50_30_20",
    take_home_cents: 520000,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });
  await db.goals.add({
    id: "jar-ef",
    kind: "save",
    title: "Emergency fund",
    target_cents: 100000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: null,
    baseline_cents: null,
    group_id: null,
    status: "active",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });
  return db;
}

describe("Home", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says whether you spent less than you got, shows set aside, and nudges on payday with one tap", async () => {
    const user = userEvent.setup();
    const db = await seedPayAndBudget();
    await db.entries.bulkAdd([
      entry("p1", "2026-10-02", 240000, "ACME PAYROLL", "in"),
      entry("p2", "2026-10-09", 240000, "ACME PAYROLL", "in"),
      entry("r1", "2026-10-01", 165000, "Rent"),
      entry("s1", "2026-10-05", 266000, "Shopping"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });

    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() =>
      expect(hero).toHaveTextContent("Got $4,800.00 · Spent $4,310.00 · Kept $490.00"),
    );
    await waitFor(() =>
      expect(within(hero).getByRole("status")).toHaveTextContent("You spent less than you earned"),
    );
    // The old spend meter repeated the Out bar and is gone (owner, October 19, 2026).
    expect(within(hero).queryByRole("progressbar")).toBeNull();

    // Save target: 20% of $5,200 take-home = $1,040
    const aside = screen.getByRole("link", { name: "Set aside this month, open Goals" });
    await waitFor(() => expect(aside).toHaveTextContent("Set aside $0.00 of $1,040.00 this month"));
    expect(aside).toHaveTextContent("0 of 1 payday set aside so far");

    // Payday today: 20% of the $2,400 paycheck
    const move = await screen.findByRole("region", {
      name: "Payday. Set aside $480.00 before it goes.",
    });
    await user.click(within(move).getByRole("button", { name: "Log $480.00 set aside" }));
    await waitFor(() =>
      expect(aside).toHaveTextContent("Set aside $480.00 of $1,040.00 this month"),
    );
    expect(aside).toHaveTextContent("1 of 1 payday set aside so far");
    const events = await db.goal_events.toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      goal_id: "jar-ef",
      type: "deposit",
      amount_cents: 48000,
      date: "2026-10-10",
    });
    // Then the starter fund is the next move: $1,000 − $480
    const next = await screen.findByRole("region", { name: "Build your $1K starter fund" });
    expect(next).toHaveTextContent("$520.00 to go");
  });

  it("money moved out of a jar leaves Home's saved and set aside, like on the goal screen", async () => {
    const db = await seedPayAndBudget();
    await db.settings.update("pay", {
      value: {
        amount_cents: 240000,
        frequency: "biweekly",
        next_payday: "2026-10-16",
        monthly_cents: 520000,
      },
    });
    await db.goals.add({
      id: "jar-trip",
      kind: "save",
      title: "Trip",
      target_cents: 200000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    await addGoalEvent(db, "jar-ef", "deposit", "2026-10-03", 60000);
    await moveMoney(db, "jar-ef", "jar-trip", 50000, "2026-10-05");
    installFakeApi({ session: readySession() });
    renderApp("/");
    // $600 put in; the $500 move is not new money set aside
    const aside = await screen.findByRole("link", { name: "Set aside this month, open Goals" });
    await waitFor(() =>
      expect(aside).toHaveTextContent("Set aside $600.00 of $1,040.00 this month"),
    );
    // The emergency jar holds $100 after the move: $1,000 − $100
    const next = await screen.findByRole("region", { name: "Build your $1K starter fund" });
    expect(next).toHaveTextContent("$900.00 to go");
  });

  it("says when you spent more than you got, and asks for pay when none is set", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("p1", "2026-10-02", 300000, "ACME PAYROLL", "in"),
      entry("s1", "2026-10-05", 321000, "Shopping"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() =>
      expect(within(hero).getByRole("status")).toHaveTextContent("You spent more than you earned"),
    );
    expect(await screen.findByRole("region", { name: "Set your monthly pay" })).toBeInTheDocument();
    // No pay and no jar yet: no empty "Set aside $0.00" card; the setup checklist instead
    expect(screen.queryByRole("link", { name: "Set aside this month, open Goals" })).toBeNull();
    expect(
      await screen.findByRole("region", { name: /Make Qash yours · \d of 6/ }),
    ).toBeInTheDocument();
  });

  it("a forecast shortfall replaces the next-move card", async () => {
    const db = await seedPayAndBudget();
    await db.entries.bulkAdd([
      entry("p1", "2026-10-09", 240000, "ACME PAYROLL", "in"),
      entry("s1", "2026-10-07", 266000, "Shopping"),
    ]);
    await db.balance_anchors.add({
      id: "a1",
      account_id: "acct-cash",
      as_of: "2026-10-05",
      balance_cents: 10000,
      source: "statement",
      created_at: "2026-10-05T00:00:00Z",
    });
    await db.recurring_series.add({
      id: "rent",
      payee: "RENT",
      label: "Rent",
      kind: "bill",
      expected_cents: 165000,
      interval: "monthly",
      next_date: "2026-10-25",
      status: "confirmed",
      source: "manual",
      account_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/");
    const warn = await screen.findByRole("link", {
      name: "Shortfall warning, open the next 30 days",
    });
    expect(warn).toHaveTextContent(
      /(You may be short \$[\d,]+\.\d\d on|Below your cushion from Oct \d+, short up to \$[\d,]+\.\d\d by) \w{3} \d+/,
    );
    expect(screen.queryByRole("region", { name: /Payday\. Set aside/ })).toBeNull();
  });
});
