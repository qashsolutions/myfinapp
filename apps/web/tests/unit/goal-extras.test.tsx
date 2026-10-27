import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { addGoalEvent, createGoal } from "../../src/features/goals/useGoals.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function seedJar(overrides: Record<string, unknown> = {}) {
  const db = openDb("u1");
  await seedDefaults(db);
  return createGoal(db, {
    kind: "save",
    title: "Travel",
    target_cents: 200000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: "2027-01-09",
    baseline_cents: null,
    group_id: null,
    cadence: "weekly",
    per_period_cents: null,
    is_ongoing: false,
    paused_at: null,
    pauses: [],
    priority: null,
    why_text: "Lisbon with Sam, next June",
    milestones_bps: [2500, 5000, 7500],
    ...overrides,
  } as Parameters<typeof createGoal>[1]);
}

describe("Custom-goal extras (fast-follow 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a jar with a cadence and milestones; the plan line comes from the engine", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/goals/new");
    await screen.findByRole("heading", { level: 1, name: "New goal" });
    expect(screen.getByRole("button", { name: "Change how often" })).toHaveTextContent(
      "just by the date",
    );
    await user.click(screen.getByRole("button", { name: "Change how often" }));
    const sheet = await screen.findByRole("dialog", { name: "How often?" });
    await user.click(within(sheet).getByRole("radio", { name: "Every month" }));
    await user.click(within(sheet).getByRole("button", { name: "Use this" }));
    // $2,000 by Apr 10, 2027 (6 months) = $333.33 a month
    const options = screen.getByRole("region", { name: "Jar options" });
    await waitFor(() =>
      expect(within(options).getByRole("status")).toHaveTextContent(
        "$333.33 a month · 6 months to $2,000.00 · first deposit Nov 10",
      ),
    );
    await user.type(screen.getByLabelText("Why it matters (optional)"), "Lisbon with Sam");
    expect(
      within(options).getByRole("switch", { name: "Milestones at 25%, 50%, 75%" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create jar" }));
    await screen.findByRole("heading", { level: 1, name: "Travel" });
    const goals = await db.goals.toArray();
    expect(goals[0]).toMatchObject({
      cadence: "monthly",
      is_ongoing: false,
      why_text: "Lisbon with Sam",
      milestones_bps: [2500, 5000, 7500],
    });
    expect(
      (await db.goal_milestones.toArray()).map((m) => [m.bps, m.target_cents, m.reached_at]),
    ).toEqual([
      [2500, 50000, null],
      [5000, 100000, null],
      [7500, 150000, null],
    ]);
    expect(screen.getByText("“Lisbon with Sam”")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Plan" })).toHaveTextContent(
      "$333.33 a month",
    );
  });

  it("milestones stamp when reached, money moves between jars, the jar pauses and resumes, and a template is saved and reused", async () => {
    const user = userEvent.setup();
    const jar = await seedJar();
    const db = openDb("u1");
    const other = await createGoal(db, {
      kind: "save",
      title: "New car",
      target_cents: 500000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
    });
    await addGoalEvent(db, jar.id, "deposit", "2026-10-05", 60000);
    installFakeApi({ session: readySession() });
    renderApp(`/goals/${jar.id}`);
    await screen.findByRole("heading", { level: 1, name: "Travel" });
    const milestones = await screen.findByRole("region", { name: "Milestones" });
    await waitFor(() => expect(milestones).toHaveTextContent("✓ 25% · $500.00"));
    expect(milestones).toHaveTextContent("50% · $1,000.00");
    await waitFor(async () =>
      expect((await db.goal_milestones.get(`${jar.id}:2500`))?.reached_at).toBe("2026-10-10"),
    );
    expect((await db.goal_milestones.get(`${jar.id}:5000`))?.reached_at).toBeNull();

    // Move $100 to New car: a withdrawal here, a deposit there
    await user.click(screen.getByRole("button", { name: "Move money" }));
    const move = await screen.findByRole("dialog", { name: "Move money to another jar" });
    await user.selectOptions(within(move).getByLabelText("To"), other.id);
    await user.type(within(move).getByLabelText("Amount"), "100");
    await user.click(within(move).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Moved $100.00 to New car."),
    );
    const events = await db.goal_events.toArray();
    expect(events.map((e) => [e.goal_id, e.type, e.amount_cents]).sort()).toEqual(
      [
        [jar.id, "deposit", 60000],
        [jar.id, "withdrawal", 10000],
        [other.id, "deposit", 10000],
      ].sort(),
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "25 percent" })).toBeInTheDocument(),
    );

    // Pause: the chip shows, the plan holds
    await user.click(screen.getByRole("button", { name: "Pause jar" }));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(await db.goals.get(jar.id)).toMatchObject({
      paused_at: "2026-10-10",
      pauses: [{ start: "2026-10-10", end: null }],
    });
    await user.click(screen.getByRole("button", { name: "Resume jar" }));
    await waitFor(async () => expect((await db.goals.get(jar.id))?.paused_at).toBeNull());
    expect((await db.goals.get(jar.id))?.pauses).toEqual([
      { start: "2026-10-10", end: "2026-10-10" },
    ]);

    // Save as my template, then start a new jar from it
    await user.click(screen.getByRole("button", { name: "Save as my template" }));
    const tpl = await screen.findByRole("dialog", { name: "Save as my template" });
    await user.clear(within(tpl).getByLabelText("Template name"));
    await user.type(within(tpl).getByLabelText("Template name"), "Trip jar");
    await user.click(within(tpl).getByRole("button", { name: "Save template" }));
    await waitFor(async () => expect(await db.goal_templates.count()).toBe(1));
    expect((await db.goal_templates.toArray())[0]?.payload).toMatchObject({
      title: "Travel",
      target_cents: 200000,
      months: 3,
      cadence: "weekly",
      why_text: "Lisbon with Sam, next June",
    });
    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("link", { name: "+ New" }));
    await screen.findByRole("heading", { level: 1, name: "New goal" });
    await user.click(await screen.findByRole("button", { name: "Trip jar" }));
    expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
      "Travel",
    );
    expect(screen.getByRole("button", { name: "Change how often" })).toHaveTextContent(
      "every week",
    );
    expect(screen.getByLabelText("Why it matters (optional)")).toHaveValue(
      "Lisbon with Sam, next June",
    );
  });

  it("an ongoing jar counts a streak instead of a target", async () => {
    const jar = await seedJar({
      title: "Rainy day",
      target_cents: null,
      end_date: null,
      cadence: "monthly",
      per_period_cents: 10000,
      is_ongoing: true,
      milestones_bps: [],
      start_date: "2026-09-01",
    });
    const db = openDb("u1");
    await addGoalEvent(db, jar.id, "deposit", "2026-09-05", 10000);
    await addGoalEvent(db, jar.id, "deposit", "2026-10-03", 12000);
    installFakeApi({ session: readySession() });
    renderApp(`/goals/${jar.id}`);
    await screen.findByRole("heading", { level: 1, name: "Rainy day" });
    const streak = await screen.findByRole("region", { name: "Streak" });
    await waitFor(() => expect(streak).toHaveTextContent("2 months in a row"));
    expect(streak).toHaveTextContent(
      "$100.00 every month · $220.00 saved in all · this month: $120.00 ✓",
    );
    expect(screen.queryByRole("region", { name: "Milestones" })).toBeNull();
  });

  it("jars can be reordered; Home nudges the top jar that is behind pace", async () => {
    const user = userEvent.setup();
    const behind = await seedJar({
      title: "Behind",
      start_date: "2026-09-01",
      end_date: "2026-12-01",
      cadence: "weekly",
      milestones_bps: [],
    });
    const db = openDb("u1");
    const ok = await createGoal(
      db,
      {
        kind: "save",
        title: "On track",
        target_cents: 100000,
        target_days: null,
        label: null,
        category_id: null,
        start_date: "2026-10-01",
        end_date: null,
        baseline_cents: null,
        group_id: null,
      },
      new Date(TODAY.getTime() + 60_000), // made after "Behind"
    );
    // Home's earlier rules must not fire: pay is set (payday not today) and the starter fund is done.
    await db.settings.put({
      key: "pay",
      value: {
        amount_cents: 240000,
        frequency: "biweekly",
        next_payday: "2026-10-16",
        monthly_cents: 520000,
      },
      updated_at: "2026-10-01T00:00:00Z",
    });
    const fund = await createGoal(
      db,
      {
        kind: "save",
        title: "Emergency fund",
        target_cents: 100000,
        target_days: null,
        label: null,
        category_id: null,
        start_date: "2026-10-01",
        end_date: null,
        baseline_cents: null,
        group_id: null,
      },
      new Date(TODAY.getTime() + 120_000),
    );
    await addGoalEvent(db, fund.id, "deposit", "2026-10-02", 100000);
    installFakeApi({ session: readySession() });
    renderApp("/goals");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(await screen.findByRole("button", { name: "Reorder" }));
    await user.click(screen.getByRole("button", { name: "Move On track up" }));
    await waitFor(async () => expect((await db.goals.get(ok.id))?.priority).toBe(0));
    expect((await db.goals.get(behind.id))?.priority).toBe(1);
    await user.click(screen.getByRole("button", { name: "Done" }));
    // The top jar is the full card; the rest in progress are one line each; a full jar is
    // folded under Reached and no longer counts toward the plan.
    expect(screen.getAllByRole("link", { name: "On track" })).toHaveLength(1);
    const reached = await screen.findByRole("list", { name: "Reached" });
    const more = screen.getByRole("list", { name: "More jars in progress" });
    expect(
      within(more)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([expect.stringContaining("Behind")]);
    const fundRow = within(reached).getByRole("link", { name: /Emergency fund/ });
    await waitFor(() => expect(fundRow).toHaveTextContent("Reached"));
    expect(screen.getByText(/^Using 3 of \d+ on your plan$/)).toBeInTheDocument();

    // Home: "Behind" has saved nothing against a weekly plan that started in September
    await user.click(screen.getByRole("link", { name: "Home" }));
    const card = await screen.findByRole("region", { name: /Catch up on Behind/ });
    expect(card).toHaveTextContent(/behind pace/);
  });
});
