/**
 * What if → Savings (owner decision, November 16, 2026): one payment today from what the person
 * owns, down the payoff plan, through whatif.lump_sum. Cash and investments count by default,
 * retirement, home and car don't until switched on; nothing is moved.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { saveManual } from "../../src/features/networth/useNetWorth.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");
/** $300 at 12% with $100 a month: 4 months, $6.14 interest (bills.payoff_plan). */
const CARD = {
  id: "d-card",
  label: "Card",
  balance_cents: 30000,
  apr_bps: 1200,
  min_payment_cents: 10000,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.debts.add(CARD);
  await saveManual(db, {
    kind: "asset",
    group: "investments",
    label: "Brokerage",
    value_cents: 100000,
  });
  await saveManual(db, {
    kind: "asset",
    group: "retirement",
    label: "Rollover IRA",
    value_cents: 500000,
  });
  return db;
}

describe("What if: use savings on debt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    installFakeApi({ session: readySession() });
  });
  afterEach(() => vi.useRealTimers());

  it("$100 today on the card: a month sooner, cash and investments counted, retirement not", async () => {
    await seed();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/what-if?lever=savings&amount=10000");
    const card = await screen.findByRole("region", { name: "Use savings on debt" });
    // Investments count by default; the IRA doesn't.
    expect(
      await within(card).findByText(/You owe \$300\.00; you counted \$1,000\.00\./),
    ).toBeInTheDocument();
    expect(within(card).getByRole("switch", { name: "Count Brokerage" })).toBeChecked();
    expect(within(card).getByRole("switch", { name: "Count Rollover IRA" })).not.toBeChecked();
    // Worked by hand: $200 left at 12% with $100 a month is 3 months and $3.05 interest,
    // against 4 months and $6.14: a month sooner, $3.09 less.
    const result = await screen.findByRole("region", { name: "What changes for your debts" });
    await waitFor(() =>
      expect(result).toHaveTextContent("Debt-free 1 month sooner · $3.09 less interest"),
    );
    expect(
      screen.getByText(/\$100\.00 on Card\. Leaves \$900\.00 of what you counted\./),
    ).toBeInTheDocument();
    expect(result).toHaveTextContent("Using $100.00 of savings today");

    // Retirement counted on purpose: the total grows and the note says what it usually costs.
    await user.click(within(card).getByRole("switch", { name: "Count Rollover IRA" }));
    expect(await within(card).findByText(/you counted \$6,000\.00\./)).toBeInTheDocument();
    expect(within(card).getByRole("note")).toHaveTextContent(
      "Retirement money usually costs tax and a penalty if taken out early.",
    );
    expect(screen.getByText(/not advice/)).toBeInTheDocument();
  });

  it("all of it clears the card today, and more than counted says so", async () => {
    await seed();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/what-if?lever=savings&amount=50000");
    const result = await screen.findByRole("region", { name: "What changes for your debts" });
    await waitFor(() => expect(result).toHaveTextContent("Debt-free 4 months sooner"));
    expect(screen.getByText(/Clears Card · \$200\.00 more than you owe\./)).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Use savings on debt" });
    await user.type(within(card).getByLabelText(/Your own amount/), "2000");
    await user.click(within(card).getByRole("button", { name: "Use" }));
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "That's more than the $1,000.00 you counted.",
    );
  });

  it("with nothing owned yet, it points to Net worth", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.debts.add(CARD);
    renderApp("/what-if?lever=savings");
    const card = await screen.findByRole("region", { name: "Use savings on debt" });
    expect(within(card).getByRole("link", { name: "Net worth" })).toHaveAttribute(
      "href",
      "/net-worth",
    );
  });
});
