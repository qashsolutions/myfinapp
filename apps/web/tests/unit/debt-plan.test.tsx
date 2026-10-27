import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function seedDebts(cardMin = 2000) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.debts.bulkAdd([
    {
      id: "d-card",
      label: "Card",
      balance_cents: 20000,
      apr_bps: 2400,
      min_payment_cents: cardMin,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "d-loan",
      label: "Loan",
      balance_cents: 20000,
      apr_bps: 1200,
      min_payment_cents: 2000,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
  ]);
  return db;
}

describe("Debt payoff planner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the avalanche plan at minimums, then what an extra $50 buys, from the golden numbers", async () => {
    const user = userEvent.setup();
    const db = await seedDebts();
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await screen.findByRole("heading", { level: 1, name: "Bills & debt" });
    await user.click(screen.getByRole("radio", { name: "Debt payoff" }));
    const plan = await screen.findByRole("region", { name: "Payoff plan" });
    await waitFor(() => expect(within(plan).getByRole("status")).toHaveTextContent(/Debt-free by/));
    expect(within(plan).getByRole("radio", { name: "Minimums only" })).toBeChecked();
    expect(plan).toHaveTextContent("at $40.00 a month");

    await user.click(within(plan).getByRole("radio", { name: "+$50.00" }));
    await waitFor(() => expect(plan).toHaveTextContent("Debt-free by March 2027"));
    expect(plan).toHaveTextContent("5 months at $90.00 a month · $15.45 in interest");
    expect(plan).toHaveTextContent(
      /With \$50\.00 extra: \d+ months sooner and \$[\d,.]+ less interest/,
    );
    expect(plan).toHaveTextContent("Card: paid off January 2027 · $8.01 interest");
    expect(plan).toHaveTextContent("Loan: paid off March 2027 · $7.44 interest");
    expect(
      within(plan).getByRole("img", { name: /Total balance falling to zero over 5 months/ }),
    ).toBeInTheDocument();
    expect(await db.settings.get("debt.extra_cents")).toMatchObject({ value: 5000 });
    expect(await db.computed_results.get("payoff_plan:2026-10-10")).toMatchObject({
      kind: "payoff_plan",
      payload: { extra_cents: 5000, months: 5, debt_free_month: "2027-03" },
    });

    await user.type(within(plan).getByLabelText("Other extra amount each month"), "150");
    await user.click(within(plan).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(plan).toHaveTextContent("at $190.00 a month"));
    expect(await db.settings.get("debt.extra_cents")).toMatchObject({ value: 15000 });
  });

  it("says when the minimums never catch the interest", async () => {
    const user = userEvent.setup();
    const db = await seedDebts(100); // $1 against 2% a month on $200
    await db.debts.delete("d-loan");
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await screen.findByRole("heading", { level: 1, name: "Bills & debt" });
    await user.click(screen.getByRole("radio", { name: "Debt payoff" }));
    const plan = await screen.findByRole("region", { name: "Payoff plan" });
    await waitFor(() =>
      expect(within(plan).getByRole("status")).toHaveTextContent(
        /balances grow instead of shrinking/,
      ),
    );
    await user.click(within(plan).getByRole("radio", { name: "+$100.00" }));
    await waitFor(() => expect(within(plan).getByRole("status")).toHaveTextContent(/Debt-free by/));
  });
});
