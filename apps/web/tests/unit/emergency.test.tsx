import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

describe("Emergency fund as a jar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows runway, milestones and the plan's ETA on the Emergency fund jar", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.goals.add({
      id: "jar-ef",
      kind: "save",
      title: "Emergency fund",
      target_cents: 918600,
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
      amount_cents: 62000,
      created_at: "2026-09-15T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/goals/jar-ef");
    await screen.findByRole("navigation", { name: "Primary" });
    const runway = await screen.findByRole("region", { name: "Runway" });
    await waitFor(() => expect(runway).toHaveTextContent("Add your essentials"));
    expect(runway).toHaveTextContent("$620.00 saved");

    await user.click(within(runway).getByRole("button", { name: "Edit essentials and plan" }));
    const sheet = await screen.findByRole("dialog", { name: "Essentials and plan" });
    await user.type(within(sheet).getByLabelText("Monthly essentials"), "3,062");
    await user.type(within(sheet).getByLabelText("Monthly amount you'll add"), "154");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    // 62000 × 10 ÷ 306200 = 2.02 -> 0.2 months, the mockup's number
    await waitFor(() => expect(runway).toHaveTextContent("0.2 months"));
    expect(runway).toHaveTextContent("$620.00 saved · essentials $3,062.00/month");

    const milestones = screen.getByRole("region", { name: "Milestones" });
    await waitFor(() => expect(milestones).toHaveTextContent("Starter fund$620.00 / $1,000.00"));
    expect(milestones).toHaveTextContent("1 month of essentials$620.00 / $3,062.00");
    expect(milestones).toHaveTextContent("3 months$620.00 / $9,186.00");
    expect(milestones).toHaveTextContent(
      "At $154.00 a month: starter fund in 3 months, 3-month target in 56 months.",
    );

    await user.click(screen.getByRole("radio", { name: "6-month target" }));
    await waitFor(() => expect(milestones).toHaveTextContent("6 months$620.00 / $18,372.00"));
    expect(milestones).toHaveTextContent("6-month target in 116 months");
    expect(await db.emergency_fund.get("me")).toMatchObject({
      essentials_cents: 306200,
      monthly_plan_cents: 15400,
      target_months: 6,
    });
    // No product explainers any more (owner decision, October 18, 2026: Learn became Insights)
    expect(screen.queryByRole("link", { name: /Where should this money live/ })).toBeNull();
  });

  it("uses Budget's planned needs as essentials until the user enters their own", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
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
      target_cents: 100000,
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
      amount_cents: 130000,
      created_at: "2026-09-15T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/goals/jar-ef");
    const runway = await screen.findByRole("region", { name: "Runway" });
    // needs = 50% of $5,200 = $2,600; 130000 × 10 ÷ 260000 = 5 -> 0.5 months
    await waitFor(() => expect(runway).toHaveTextContent("0.5 months"));
    expect(runway).toHaveTextContent("essentials $2,600.00/month (needs from your budget)");
    expect(screen.getByRole("region", { name: "Milestones" })).toHaveTextContent(
      "Set a monthly amount to see when you'd get there.",
    );
  });
});

describe("Emergency fund screen (fast-follow 1)", () => {
  it("offers to create the jar, then shows runway and milestones from it, and opens the jar", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    const first = renderApp("/emergency");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Emergency fund" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Create the Emergency fund jar" }));
    await waitFor(async () => expect(await db.goals.count()).toBe(1));
    expect((await db.goals.toArray())[0]).toMatchObject({
      kind: "save",
      title: "Emergency fund",
      target_cents: 100000,
    });
    first.unmount();

    renderApp("/emergency");
    expect(await screen.findByRole("region", { name: "Runway" })).toHaveTextContent("$0.00 saved");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Milestones" })).toHaveTextContent("Starter fund"),
    );
    await user.click(screen.getByRole("button", { name: "Open the jar to log a deposit" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Emergency fund" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Log money you set aside" }),
    ).toBeInTheDocument();
  });
});
