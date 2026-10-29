/**
 * Debt, credit and budget made visual and adjustable (October 29, 2026): the payoff timeline on
 * Home, the credit habits dot strip and the person's own guide, and the budget alert's ticks and
 * per-line "Don't alert me for this one".
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Account, type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-21T12:00:00");

function spend(id: string, cents: number, category: string): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: cents,
    direction: "out",
    merchant: "Shop",
    clean_description: "SHOP",
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
    created_at: "2026-10-05T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  };
}

async function zeroBased() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    spend("d1", 18500, "cat-dining"), // 92.5% of $200: Close
    spend("f1", 12000, "cat-fun"), // 120% of $100: Over
  ]);
  await createBudget(db, "2026-10", "zero_based", 400000, [
    { category_id: "cat-dining", planned_cents: 20000 },
    { category_id: "cat-fun", planned_cents: 10000 },
  ]);
  return db;
}

type Api = ReturnType<typeof installFakeApi>;

function budgetItems(api: Api): Array<Record<string, unknown>> {
  return (
    (
      api.calls.filter((c) => c.method === "PUT" && c.path === "/api/alerts/schedule").at(-1)
        ?.body as { items: Array<Record<string, unknown>> } | undefined
    )?.items.filter((i) => i.type === "budget_pace") ?? []
  );
}

describe("visual and adjustable debt, credit and budget (October 29, 2026)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => vi.useRealTimers());

  it("a budget bar marks Tell me at and the plan end, so Close is a position", async () => {
    await zeroBased();
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    const planned = await screen.findByRole("region", { name: "Planned by category" });
    const bar = await within(planned).findByRole("progressbar", {
      name: "Dining spent of planned",
    });
    await waitFor(() =>
      expect(bar).toHaveAttribute("aria-valuetext", "$185.00 of $200.00 · Tell me at 90% · Plan"),
    );
    // Two ticks: 90% and the plan's end at the right.
    const ticks = bar.parentElement?.querySelectorAll(".sk-progress__mark") ?? [];
    expect([...ticks].map((t) => (t as HTMLElement).style.left)).toEqual(["90%", "100%"]);
  });

  it("a line turned off in Adjust budget alerts keeps its word and makes no alert", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = await zeroBased();
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    await user.click(await screen.findByRole("button", { name: "Adjust budget alerts" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust budget alerts" });
    const dining = within(sheet).getByRole("switch", { name: "Alert me for Dining" });
    expect(dining).toBeChecked();
    await user.click(dining);
    await waitFor(async () =>
      expect((await db.settings.get("budget.alert_off"))?.value).toEqual(["cat-dining"]),
    );
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    const planned = screen.getByRole("region", { name: "Planned by category" });
    const line = within(planned).getByRole("button", { name: "Move money to or from Dining" })
      .parentElement as HTMLElement;
    expect(line).toHaveTextContent(/^Close/);
    // Off: its tick reads "Close at", not "Tell me at".
    expect(within(line).getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "$185.00 of $200.00 · Close at 90% · Plan",
    );
  });

  it("the alert schedule leaves out a line the person turned off", async () => {
    const db = await zeroBased();
    await db.settings.put({ key: "budget.alert_off", value: ["cat-dining"], updated_at: "x" });
    const api = installFakeApi({ session: readySession() });
    renderApp("/insights");
    await screen.findByRole("navigation", { name: "Primary" });
    // Only Fun, past its plan: one item at 100%.
    await waitFor(() => expect(budgetItems(api)).toHaveLength(1), { timeout: 4000 });
    expect(String(budgetItems(api)[0]?.dedupe_key)).toMatch(/:10000$/);
  });

  it("credit habits: the dot strip, the limit gauge at the person's own guide", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = openDb("u1");
    await seedDefaults(db);
    const card: Account = {
      id: "acct-cc",
      label: "Visa",
      type: "credit_card",
      last4: "4242",
      institution: null,
      currency: "USD",
      created_at: "2026-07-01T00:00:00Z",
      due_day: null,
      linked: { connection_id: "bc1", account_id: "acc-cc" },
    };
    await db.accounts.put(card);
    await db.entries.bulkAdd([
      { ...spend("x1", 30000, "cat-dining"), account_id: card.id, date: "2026-09-01" },
      {
        ...spend("x2", 30000, "cat-dining"),
        account_id: card.id,
        date: "2026-09-24",
        direction: "in",
      },
    ]);
    await db.card_details.put({
      account_id: card.id,
      statement_balance_cents: 15000,
      statement_date: null,
      due_date: "2026-11-25",
      minimum_cents: 2500,
      last_payment_cents: null,
      last_payment_date: null,
      limit_cents: 100000,
      apr_bps: 2499,
      is_overdue: false,
      updated_at: "2026-10-20T00:00:00Z",
    });
    await db.card_due_dates.bulkPut([
      {
        id: `${card.id}:2026-09-25`,
        account_id: card.id,
        due_date: "2026-09-25",
        statement_balance_cents: 30000,
        minimum_cents: 2500,
        updated_at: "2026-09-10T00:00:00Z",
      },
      {
        id: `${card.id}:2026-11-25`,
        account_id: card.id,
        due_date: "2026-11-25",
        statement_balance_cents: 15000,
        minimum_cents: 2500,
        updated_at: "2026-10-20T00:00:00Z",
      },
    ]);
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
    renderApp("/credit-habits");
    const shown = await screen.findByRole("article", { name: "Visa ••4242" });
    // 15,000 of a 100,000 limit: 15%, under the default 30% guide.
    await waitFor(() => expect(shown).toHaveTextContent("15% of your limit used · under 30%"));
    expect(
      within(shown).getByRole("img", { name: /^Due dates: Sep 25 on time, Nov 25 not yet\.$/ }),
    ).toBeInTheDocument();
    expect(within(shown).getByRole("progressbar", { name: "Limit used" })).toHaveAttribute(
      "aria-valuetext",
      "15% of the limit used · Guide 30%",
    );
    expect(shown).toHaveTextContent("Paid in full 1 month");

    await user.click(screen.getByRole("button", { name: "Adjust credit habits" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust credit habits" });
    await user.type(within(sheet).getByLabelText("Your own guide, 1 to 100 percent"), "10");
    const row = within(sheet)
      .getByLabelText("Your own guide, 1 to 100 percent")
      .closest(".own-choice") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(async () =>
      expect((await db.settings.get("credit.guide_bps"))?.value).toBe(1000),
    );
    // The rule reads the person's guide: 15% is now over it.
    await waitFor(() => expect(shown).toHaveTextContent("15% of your limit used · over 10%"));
    // A linked card's due dates come from the bank: no due-day picker for it.
    expect(within(sheet).queryByLabelText(/Own due day/)).toBeNull();
  });

  it("Home's Debt-free card carries a small line of the total falling to zero", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.debts.add({
      id: "a",
      label: "Card",
      balance_cents: 20000,
      apr_bps: 2400,
      min_payment_cents: 2000,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Open Debt payoff" });
    await waitFor(() => expect(card.querySelector(".payoff-spark polyline")).not.toBeNull());
  });
});
