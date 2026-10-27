import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { debtGroupFor } from "../../src/features/networth/useNetWorth.ts";
import { todayIso } from "../../src/lib/format.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const NOW = "2026-01-02T00:00:00.000Z";

function lastMonth(): string {
  const [y, m] = todayIso().split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Cash $2,100 and savings $5,000 owned; a card owing $1,500 and a car loan of $12,000. */
async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.accounts.bulkAdd([
    {
      id: "acct-sav",
      label: "Ally Savings",
      type: "savings",
      last4: "4321",
      institution: null,
      currency: "USD",
      created_at: NOW,
    },
    {
      id: "acct-card",
      label: "Visa",
      type: "credit_card",
      last4: "9876",
      institution: null,
      currency: "USD",
      created_at: NOW,
    },
  ]);
  await db.balance_anchors.bulkAdd([
    {
      id: "b1",
      account_id: "acct-cash",
      as_of: "2026-01-01",
      balance_cents: 210000,
      source: "user",
      created_at: NOW,
    },
    {
      id: "b2",
      account_id: "acct-sav",
      as_of: "2026-01-01",
      balance_cents: 500000,
      source: "user",
      created_at: NOW,
    },
    // A card's owed balance is stored below zero.
    {
      id: "b3",
      account_id: "acct-card",
      as_of: "2026-01-01",
      balance_cents: -150000,
      source: "user",
      created_at: NOW,
    },
  ]);
  await db.debts.add({
    id: "d1",
    label: "Car loan",
    balance_cents: 1200000,
    apr_bps: 699,
    min_payment_cents: 35000,
    created_at: NOW,
    updated_at: NOW,
  });
  await db.net_worth_snapshots.add({
    month: lastMonth(),
    assets_cents: 0,
    debts_cents: 0,
    net_cents: -10000_00,
    rules_version: "0.21.0",
    updated_at: NOW,
  });
  return db;
}

describe("Net worth (owner decision, October 19, 2026)", () => {
  it("adds accounts and debts, counts a card as owed, and says what changed over the range", async () => {
    await seed();
    localStorage.setItem("stackd.range.networth", "Month");
    installFakeApi({ session: readySession() });
    renderApp("/net-worth");
    // Own 2,100 + 5,000 = 7,100; owe 1,500 + 12,000 = 13,500; net −6,400; nothing moved this month
    const hero = await screen.findByRole("region", { name: "−$6,400.00" });
    expect(await within(hero).findByText("$0.00 this month")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What you own/ })).toHaveTextContent("$7,100.00");
    expect(screen.getByRole("heading", { name: /What you owe/ })).toHaveTextContent("$13,500.00");
    expect(screen.getByText("Visa ••9876")).toBeInTheDocument();
    expect(screen.getByText(/Car loans · From Debt payoff/)).toBeInTheDocument();
  });

  it("rebuilds the range from balances and entries (time ranges, October 20, 2026)", async () => {
    const user = userEvent.setup();
    const db = await seed();
    // $1,000 into savings today: the month started at −6,400 and is −5,400 now.
    await db.entries.add({
      id: "e1",
      date: todayIso(),
      amount_cents: 100000,
      direction: "in",
      merchant: "Transfer in",
      clean_description: "TRANSFER IN",
      raw_description: null,
      category_id: null,
      account_id: "acct-sav",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: NOW,
      updated_at: NOW,
    });
    installFakeApi({ session: readySession() });
    renderApp("/net-worth");
    const hero = await screen.findByRole("region", { name: "−$5,400.00" });
    await user.click(within(hero).getByRole("radio", { name: "this month" }));
    // The month started below zero, so there is no percent.
    expect(await within(hero).findByText("▲ $1,000.00 this month")).toBeInTheDocument();
    expect(localStorage.getItem("stackd.range.networth")).toBe("Month");
    expect(
      within(hero).getByRole("img", { name: /^Net worth: −\$6,400.00 on .*, −\$5,400.00 today$/ }),
    ).toBeInTheDocument();
  });

  it("leaving an account out and adding something by hand both change the total", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/net-worth");
    await screen.findByRole("region", { name: "−$6,400.00" });
    await user.click(screen.getByRole("switch", { name: "Count Visa ••9876" }));
    // 7,100 − 12,000
    expect(await screen.findByRole("region", { name: "−$4,900.00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Something you own" }));
    const sheet = await screen.findByRole("dialog", { name: "Something you own" });
    await user.type(within(sheet).getByLabelText("Name"), "401(k)");
    await user.click(within(sheet).getByRole("radio", { name: "Retirement" }));
    await user.type(within(sheet).getByLabelText("What it's worth"), "20,000");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    // 7,100 + 20,000 − 12,000
    expect(await screen.findByRole("region", { name: "$15,100.00" })).toBeInTheDocument();
    expect(screen.getByText(/Retirement · Updated/)).toBeInTheDocument();

    // This month's snapshot follows the total, with the rules version stamped.
    await waitFor(async () =>
      expect((await db.net_worth_snapshots.get(todayIso().slice(0, 7)))?.net_cents).toBe(1510000),
    );
  });

  it("Insights shows the total and the change", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: /Net worth/ });
    await waitFor(() => expect(card).toHaveTextContent("−$6,400.00"));
    expect(card).toHaveTextContent("Up−$6,400.00, up $3,600.00 since last month");
  });

  it("reads a debt's kind from its name", () => {
    expect(debtGroupFor("Home mortgage")).toBe("mortgage");
    expect(debtGroupFor("Honda car loan")).toBe("auto_loan");
    expect(debtGroupFor("Student loan")).toBe("student_loan");
    expect(debtGroupFor("Chase card")).toBe("card");
    expect(debtGroupFor("Loan from mom")).toBe("personal_loan");
    expect(debtGroupFor("IRS")).toBe("other_debt");
  });
});
