import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function seed(minimum = 2000) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.debts.bulkAdd([
    {
      id: "a",
      label: "Card",
      balance_cents: 20000,
      apr_bps: 2400,
      min_payment_cents: minimum,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
  ]);
  return db;
}

describe("Home's Debt-free card (October 28, 2026)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => vi.useRealTimers());

  it("is hidden with no debts", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("button", { name: "Customize Home" });
    expect(screen.queryByRole("link", { name: "Open Debt payoff" })).toBeNull();
  });

  it("shows the debt-free month at the person's extra and order, and opens Debt payoff", async () => {
    // Worked by hand: $200 at 24% (2% a month) paying $20 + $50 extra: 13,400 after the first
    // month, 6,668 after the second, 0 in the third; months count from November → January 2027.
    const user = userEvent.setup();
    const db = await seed();
    await db.settings.put({ key: "debt.extra_cents", value: 5000, updated_at: "x" });
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Open Debt payoff" });
    // The month leads as the value, in plain colour: "Debt-free" is a claim about then, not now.
    await waitFor(() => expect(card).toHaveTextContent("Jan 2027"));
    expect(card).toHaveTextContent("Debt-free at this pace");
    expect(screen.getByText("Jan 2027")).toHaveClass("word--plain");
    await user.click(card);
    expect(await screen.findByRole("region", { name: "Payoff plan" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Debt payoff" })).toBeChecked();
  });

  it("says Stalled when the payments never catch the interest", async () => {
    await seed(100);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Open Debt payoff" });
    await waitFor(() => expect(card).toHaveTextContent("Stalled"));
  });
});
