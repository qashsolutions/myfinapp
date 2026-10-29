import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSnapshot, mergeSnapshot } from "../../src/data/backup/snapshot.ts";
import { type Goal, openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-28T12:00:00");
const STAMP = "2026-10-01T00:00:00Z";

function jar(over: Partial<Goal>): Goal {
  return {
    id: "g-jar",
    kind: "save",
    title: "Lisbon",
    target_cents: 100000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-08-01",
    end_date: "2027-12-01",
    baseline_cents: null,
    group_id: null,
    status: "active",
    created_at: STAMP,
    updated_at: STAMP,
    ...over,
  };
}

const CARD = {
  id: "d-card",
  label: "Card",
  balance_cents: 30000,
  apr_bps: 1200,
  min_payment_cents: 10000,
  created_at: STAMP,
  updated_at: STAMP,
};

describe("Goals that grow and What if (October 28, 2026)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    await seedDefaults(openDb("u1"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Kids' education turns Grows over time on and the jar's target is the future cost", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/goals/new");
    await user.click(await screen.findByRole("button", { name: /Change what it's for/ }));
    await user.click(await screen.findByRole("radio", { name: "Kids' education" }));
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("switch", { name: /Grows over time/ })).toBeChecked();
    // $2,000 today, rising 5% a year, growing 5% a year, 6 months: $2,050.52 then and
    // F × i ÷ ((1 + i)^6 − 1) = $338.21 a month (i = 5% ÷ 12).
    const pace = screen.getByRole("region", { name: "Pace" });
    await waitFor(() =>
      expect(pace).toHaveTextContent("About $338.21 a month from now · $2,050.52 by April 2027"),
    );
    // At 3% instead the cost reaches $2,030.19 and the month is $334.86.
    const own = screen.getByLabelText("Your own yearly rise, in percent");
    const rise = within(own.closest(".own-choice") as HTMLElement);
    await user.click(rise.getByRole("radio", { name: "3%" }));
    await waitFor(() => expect(pace).toHaveTextContent("About $334.86 a month"));
    // Your own rise: 600% is refused with the limit.
    await user.type(own, "600{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("from 0 to 500");
    await user.click(rise.getByRole("radio", { name: "5%" }));

    await user.click(screen.getByRole("button", { name: "Create jar" }));
    const grows = await screen.findByRole("region", { name: "Grows over time" });
    await waitFor(() => expect(grows).toHaveTextContent("On track"));
    expect(grows).toHaveTextContent("About $338.21 a month from now");
    expect(grows).toHaveTextContent("not a prediction or advice");
    const goal = (await openDb("u1").goals.toArray()).find((g) => g.title === "Kids' education");
    expect(goal?.target_cents).toBe(205052);
    expect(goal?.grow).toEqual({
      today_cents: 200000,
      cost_rise_bps: 500,
      return_bps: 500,
      priced_on: "2026-10-28",
    });
  });

  it("a grows jar two months on with nothing put in is Behind", async () => {
    const db = openDb("u1");
    await db.goals.add(
      jar({
        id: "g-home",
        title: "A home",
        target_cents: 150000,
        start_date: "2026-08-28",
        end_date: "2027-02-28",
        grow: { today_cents: 200000, cost_rise_bps: 0, return_bps: 0, priced_on: "2026-08-28" },
      }),
    );
    installFakeApi({ session: readySession() });
    renderApp("/goals/g-home");
    const grows = await screen.findByRole("region", { name: "Grows over time" });
    // Planned on Aug 28 at $2,000 ÷ 6 = $333.33 a month; three months in, nothing put in.
    await waitFor(() => expect(grows).toHaveTextContent("Behind"));
    // From now: $2,000 over the 4 months left.
    expect(grows).toHaveTextContent("About $500.00 a month from now · $2,000.00 by February 2027");
    // The jar's target follows the rule's future cost.
    await waitFor(async () => expect((await db.goals.get("g-home"))?.target_cents).toBe(200000));
  });

  it("What if: more on one loan, and half every two weeks", async () => {
    const user = userEvent.setup();
    await openDb("u1").debts.add(CARD);
    installFakeApi({ session: readySession() });
    renderApp("/what-if");
    expect(await screen.findByRole("heading", { level: 1, name: "What if" })).toBeInTheDocument();
    // $300 at 12% with $100 a month takes 4 months and $6.14 interest; $100 more: 2 months, $4.03.
    const result = await screen.findByRole("region", { name: "What changes for Card" });
    await waitFor(() =>
      expect(result).toHaveTextContent("Card paid off 2 months sooner · $2.11 less interest"),
    );
    expect(result).toHaveTextContent("Sooner");
    // Half every two weeks adds $100 ÷ 12 = $8.33 a month: $3.95 interest, $2.19 less.
    await user.click(screen.getByRole("switch", { name: /Pay half every two weeks/ }));
    await waitFor(() => expect(result).toHaveTextContent("$2.19 less interest"));
    expect(screen.getByText(/not advice/)).toBeInTheDocument();
  });

  it("What if: spend less and put it in the top jar or on the debts", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await db.debts.add(CARD);
    await db.goals.add(jar({}));
    await db.goal_events.add({
      id: "e1",
      goal_id: "g-jar",
      date: "2026-10-20",
      type: "deposit",
      amount_cents: 30000,
      created_at: "2026-10-20T10:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/what-if?goal=g-jar");
    // $700 left at $100 a month (the last 3 months' $300 ÷ 3) is 7 months; with $50 more, 5.
    const onJar = await screen.findByRole("region", { name: "What changes for Lisbon" });
    await waitFor(() => expect(onJar).toHaveTextContent("Lisbon jar done 2 months earlier"));
    expect(onJar).toHaveTextContent("March 2027 instead of May 2027");
    // On the debts instead: $150 a month pays the $300 card in 3 months, $1.56 less interest.
    const onDebts = screen.getByRole("region", { name: "What changes for your debts" });
    expect(onDebts).toHaveTextContent("Debt-free 1 month sooner · $1.56 less interest");
    // Your own amount: $200 more a month fills the jar in 3 months.
    await user.type(screen.getByLabelText(/Your own amount: Less on/), "200");
    await user.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    await waitFor(() => expect(onJar).toHaveTextContent("Lisbon jar done 4 months earlier"));
  });

  it("a grows jar's inputs travel in the backup and a newer edit wins the merge", async () => {
    const a = openDb("u1");
    const grow = {
      today_cents: 200000,
      cost_rise_bps: 500,
      return_bps: 500,
      priced_on: "2026-10-28",
    };
    await a.goals.add(jar({ id: "g-kid", grow }));
    const snap = await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" });
    const b = openDb("u1grow");
    await b.delete();
    await b.open();
    await seedDefaults(b);
    await mergeSnapshot(b, snap);
    expect((await b.goals.get("g-kid"))?.grow).toEqual(grow);
    await b.goals.update("g-kid", {
      grow: { ...grow, return_bps: 300 },
      updated_at: "2026-10-28T12:00:00Z",
    });
    await mergeSnapshot(a, await buildSnapshot(b, { rulesVersion: "t", deviceId: "B" }));
    expect((await a.goals.get("g-kid"))?.grow?.return_bps).toBe(300);
    b.close();
  });
});
