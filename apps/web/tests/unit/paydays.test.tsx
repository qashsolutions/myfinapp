/**
 * Your own paydays (owner, October 28, 2026): twice a month and monthly take the days the person
 * picks; the forecast keeps each payday on its day of the month (the 31st stays the last day).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, type PaySettings, seedDefaults } from "../../src/data/db.ts";
import { upcomingItems } from "../../src/engine/bridge.ts";
import { payScheduleOf } from "../../src/features/budget/payDays.ts";
import { payAsSeries } from "../../src/features/forecast/useForecast.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-28T12:00:00"); // a Wednesday

const twice = (days: number[] | null, next = "2026-11-01"): PaySettings => ({
  amount_cents: 260000,
  frequency: "semimonthly",
  next_payday: next,
  monthly_cents: 520000,
  days,
});

describe("your own paydays", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paid on the 1st and 15th plans the 15th, not the 16th", async () => {
    const series = await payAsSeries(twice([1, 15]), "2026-10-28");
    expect(series.map((s) => [s.next_date, s.day])).toEqual([
      ["2026-11-01", 1],
      ["2026-11-15", 15],
    ]);
  });

  it("the 15th and the last day stay put through February, in a Year view", async () => {
    const series = await payAsSeries(twice([15, 31], "2027-01-31"), "2027-01-20");
    const up = await upcomingItems(series, [], "2027-01-20", 60);
    expect(up.items.map((i) => i.date)).toEqual([
      "2027-01-31",
      "2027-02-15",
      "2027-02-28",
      "2027-03-15",
    ]);
  });

  it("pay saved before the days were asked keeps its old reading", () => {
    expect(payScheduleOf(twice(null))).toEqual({ kind: "monthly_days", days: [1, 16] });
    expect(
      payScheduleOf({ ...twice(null, "2026-11-30"), frequency: "monthly", days: undefined }),
    ).toEqual({ kind: "monthly_days", days: [30] });
  });

  it("twice a month: 1st & 15th is suggested, other days are yours, and they're saved", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    await user.type(await screen.findByLabelText("Paycheck"), "2,600");
    await user.click(screen.getByRole("radio", { name: "Twice a month" }));
    expect(await screen.findByRole("radio", { name: "1st & 15th" })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Next paydays Nov 1 · Nov 15 · Dec 1"),
    );
    await user.click(screen.getByRole("radio", { name: "Other days" }));
    await user.selectOptions(screen.getByLabelText("First payday"), "7");
    await user.selectOptions(screen.getByLabelText("Second payday"), "31");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Next paydays Oct 31 · Nov 7 · Nov 30"),
    );
    const hero = screen.getByRole("region", { name: "Your pay a month" });
    expect(hero).toHaveTextContent("Monthly$5,200.00 a month");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(async () =>
      expect((await db.settings.get("pay"))?.value).toMatchObject({
        frequency: "semimonthly",
        days: [7, 31],
        next_payday: "2026-10-31",
      }),
    );
  });

  it("every 2 weeks: the paycheck from your statements is the suggested date, any date works", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.recurring_series.add({
      id: "s-pay",
      payee: "ACME PAYROLL",
      label: "ACME PAYROLL",
      kind: "income",
      expected_cents: 260000,
      interval: "biweekly",
      next_date: "2026-11-06",
      status: "confirmed",
      source: "detected",
      account_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    await user.type(await screen.findByLabelText("Paycheck"), "2,600");
    expect(screen.getByRole("radio", { name: "Every 2 weeks" })).toBeChecked();
    const found = await screen.findByRole("radio", {
      name: "Fri, Nov 6 · from your statements",
    });
    await waitFor(() => expect(found).toBeChecked());
    expect(screen.getByRole("radio", { name: "Fri, Oct 30" })).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Next paydays Nov 6 · Nov 20 · Dec 4"),
    );
    const own = screen.getByLabelText("Next payday, your own date");
    await user.type(own, "2026-11-04");
    await user.click(within(own.parentElement as HTMLElement).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Next paydays Nov 4 · Nov 18 · Dec 2"),
    );
  });

  it("monthly: Last day is the last day of every month", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    await user.type(await screen.findByLabelText("Paycheck"), "5,200");
    await user.click(screen.getByRole("radio", { name: "Monthly" }));
    await user.click(await screen.findByRole("radio", { name: "Last day" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Next paydays Oct 31 · Nov 30 · Dec 31"),
    );
  });
});
