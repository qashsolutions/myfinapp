import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function addDebt(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  balance: string,
  apr: string,
  minimum: string,
) {
  await user.click(screen.getByRole("button", { name: "+ Add" }));
  const sheet = await screen.findByRole("dialog", { name: "Add a card or loan" });
  await user.type(within(sheet).getByLabelText("Name"), label);
  await user.type(within(sheet).getByLabelText("Balance"), balance);
  await user.type(within(sheet).getByLabelText("APR %"), apr);
  await user.type(within(sheet).getByLabelText("Minimum payment"), minimum);
  await user.click(within(sheet).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Bills & debt: the debt payoff tab", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orders cards and loans by highest APR, and Home points at the top one", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(screen.getByRole("radio", { name: "Debt payoff" }));
    expect(await screen.findByText(/No cards or loans yet/)).toBeInTheDocument();
    await addDebt(user, "Car loan", "8,200", "6.4", "310");
    await addDebt(user, "Store card", "600", "24.90", "25");
    await addDebt(user, "Card A", "2,400", "27.99", "72");

    const list = screen.getByRole("list", { name: "Debts, highest rate first" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("Card A");
    expect(rows[0]).toContain("27.99% APR · min $72.00 · extra payments go here");
    expect(rows[1]).toContain("Store card");
    expect(rows[2]).toContain("Car loan");
    expect(rows[2]).toContain("6.40% APR");
    expect(screen.getByText("Balances $11,200.00 · minimums $407.00 a month")).toBeInTheDocument();
    expect(await db.debts.toArray()).toHaveLength(3);
    expect((await db.debts.toArray()).find((d) => d.label === "Card A")).toMatchObject({
      balance_cents: 240000,
      apr_bps: 2799,
      min_payment_cents: 7200,
    });

    // Edit one: the order follows
    await user.click(within(list).getByRole("button", { name: /Store card/ }));
    const edit = await screen.findByRole("dialog", { name: "Edit debt" });
    await user.clear(within(edit).getByLabelText("APR %"));
    await user.type(within(edit).getByLabelText("APR %"), "29");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Store card"),
    );

    // Home: pay is set, the starter fund is done, so the highest APR is the next move
    await db.budgets.add({
      id: "b",
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
      target_cents: 300000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-09-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    await db.goal_events.add({
      id: "d1",
      goal_id: "jar-ef",
      date: "2026-09-15",
      type: "deposit",
      amount_cents: 100000,
      created_at: "2026-09-15T00:00:00Z",
    });
    await user.click(screen.getByRole("link", { name: "Home" }));
    const move = await screen.findByRole("region", { name: "Attack your highest-APR card" });
    expect(move).toHaveTextContent("29.00% APR costs the most each month.");
  });
});
