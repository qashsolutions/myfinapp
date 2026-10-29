import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

/** Opens "Adjust payoff plan" (October 29, 2026): the extra and the order live there. */
async function openAdjust(user: ReturnType<typeof userEvent.setup>, plan: HTMLElement) {
  await user.click(within(plan).getByRole("button", { name: "Adjust payoff plan" }));
  return screen.findByRole("dialog", { name: "Adjust payoff plan" });
}

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
    await waitFor(() =>
      expect(within(plan).getByRole("status")).toHaveTextContent(/^[A-Z][a-z]+ \d{4}$/),
    );
    expect(plan).toHaveTextContent("Debt-free at this pace");
    expect(plan.querySelector(".word--good")).toBeNull();
    expect(plan).toHaveTextContent("at $40.00 a month");
    expect(plan).toHaveTextContent("Minimums only.");

    let sheet = await openAdjust(user, plan);
    expect(within(sheet).getByRole("radio", { name: "Minimums only" })).toBeChecked();
    expect(within(sheet).getByRole("radio", { name: "Highest rate first" })).toBeChecked();
    await user.click(within(sheet).getByRole("radio", { name: "+$50" }));
    // The sheet redraws before anything is saved.
    await waitFor(() => expect(within(sheet).getByRole("status")).toHaveTextContent("Mar 2027"));
    expect(await db.settings.get("debt.extra_cents")).toBeUndefined();
    await user.click(within(sheet).getByRole("button", { name: "Use these" }));
    await waitFor(() => expect(within(plan).getByRole("status")).toHaveTextContent("March 2027"));
    expect(plan).toHaveTextContent("5 months at $90.00 a month · $15.45 in interest");
    expect(plan).toHaveTextContent(
      /With \$50\.00 extra: \d+ months sooner and \$[\d,.]+ less interest/,
    );
    expect(plan).toHaveTextContent("Card: paid off January 2027 · $8.01 interest");
    expect(plan).toHaveTextContent("Loan: paid off March 2027 · $7.44 interest");
    expect(
      within(plan).getByRole("img", {
        name: /Total balance falls from \$400\.00 to zero by Mar 2027/,
      }),
    ).toBeInTheDocument();
    expect(await db.settings.get("debt.extra_cents")).toMatchObject({ value: 5000 });
    expect(await db.computed_results.get("payoff_plan:2026-10-10")).toMatchObject({
      kind: "payoff_plan",
      payload: {
        extra_cents: 5000,
        months: 5,
        debt_free_month: "2027-03",
        payoff_order: "avalanche",
      },
    });

    sheet = await openAdjust(user, plan);
    await user.type(within(sheet).getByLabelText("Other extra amount each month"), "150");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(within(sheet).getByRole("slider")).toHaveAttribute(
        "aria-valuetext",
        "$150.00 extra a month",
      ),
    );
    await user.click(within(sheet).getByRole("button", { name: "Use these" }));
    await waitFor(() => expect(plan).toHaveTextContent("at $190.00 a month"));
    expect(await db.settings.get("debt.extra_cents")).toMatchObject({ value: 15000 });

    // The slider tries amounts out; Cancel keeps what was saved.
    sheet = await openAdjust(user, plan);
    const slider = within(sheet).getByRole("slider");
    fireEvent.change(slider, { target: { value: "16000" } });
    expect(slider).toHaveAttribute("aria-valuetext", "$160.00 extra a month");
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
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
    expect(plan).toHaveTextContent("Stalled");
    const sheet = await openAdjust(user, plan);
    await user.click(within(sheet).getByRole("radio", { name: "+$100" }));
    await user.click(within(sheet).getByRole("button", { name: "Use these" }));
    await waitFor(() =>
      expect(within(plan).getByRole("status")).toHaveTextContent(/^[A-Z][a-z]+ \d{4}$/),
    );
  });

  it("switches to smallest balance first and shows both orders side by side from the golden numbers", async () => {
    // The golden case bills.payoff_plan/snowball_pays_the_smallest_balance_first and its avalanche twin.
    const user = userEvent.setup();
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
    await db.settings.put({
      key: "debt.extra_cents",
      value: 5000,
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/bills?tab=debt");
    const plan = await screen.findByRole("region", { name: "Payoff plan" });
    const both = await within(plan).findByRole("list", { name: "Both orders side by side" });
    await waitFor(() => expect(both).toHaveTextContent("$10.84 interest"));
    expect(both).toHaveTextContent("Highest rate first");
    expect(both).toHaveTextContent("$12.40 interest");
    expect(both).toHaveTextContent("Saves the most interest.");
    expect(both).toHaveTextContent("Clears a debt sooner.");
    expect(plan).toHaveTextContent("Card: paid off January 2027 · $8.01 interest");

    const sheet = await openAdjust(user, plan);
    await user.click(within(sheet).getByRole("radio", { name: "Smallest balance first" }));
    await user.click(within(sheet).getByRole("button", { name: "Use these" }));
    await waitFor(() =>
      expect(plan).toHaveTextContent("Loan: paid off December 2026 · $1.31 interest"),
    );
    expect(plan).toHaveTextContent("Card: paid off February 2027 · $11.09 interest");
    expect(within(plan).getByRole("status")).toHaveTextContent("February 2027");
    expect(await db.settings.get("debt.order")).toMatchObject({ value: "snowball" });
    // The list follows the chosen order: the smallest balance is where the extra goes.
    const list = await screen.findByRole("list", { name: "Debts, smallest balance first" });
    expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(/^Loan, .*rank 1$/);
  });
});
