/**
 * Suggest, then take their own value (owner decision, October 27, 2026): every picker of a
 * value offers suggestions and also the person's own value, checked against the same limits
 * the server or the rule uses.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { getRetention, purgeDateFor, retentionLabel } from "../../src/data/receipts.ts";
import { addGoalEvent, createGoal } from "../../src/features/goals/useGoals.ts";
import { checkpointsText, parseCheckpoints, parseWholeNumber } from "../../src/lib/ownValues.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

describe("own values", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses whole numbers and milestone percents, and refuses anything else", () => {
    expect(parseWholeNumber(" 14 ", 0, 14)).toBe(14);
    expect(parseWholeNumber("15", 0, 14)).toBeNull();
    expect(parseWholeNumber("2.5", 0, 14)).toBeNull();
    expect(parseWholeNumber("-1", 0, 14)).toBeNull();
    expect(parseWholeNumber("", 0, 14)).toBeNull();
    expect(parseCheckpoints("90, 10 50%")).toEqual([1000, 5000, 9000]);
    expect(parseCheckpoints("50, 50")).toEqual([5000]);
    expect(parseCheckpoints("0")).toBeNull();
    expect(parseCheckpoints("100")).toBeNull();
    expect(parseCheckpoints("10, 20, 30, 40, 50, 60")).toBeNull();
    expect(parseCheckpoints("ten")).toBeNull();
    expect(checkpointsText([1000, 5000])).toBe("10%, 50%");
  });

  it("receipt photos can be kept for the person's own number of days", async () => {
    expect(await purgeDateFor("45d", "2026-10-10")).toBe("2026-11-24");
    expect(retentionLabel("45d")).toBe("45 days");
    expect(retentionLabel("1d")).toBe("1 day");
    const db = openDb("u1");
    for (const bad of ["0d", "3651d", "abc"]) {
      await db.settings.put({ key: "receipts.retention", value: bad, updated_at: "" });
      expect(await getRetention(db)).toBe("90d");
    }

    const user = userEvent.setup();
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/me/data");
    const section = await screen.findByRole("region", { name: "Receipt photos" });
    const box = within(section).getByLabelText("Your own number of days, 1 to 3650");
    await user.type(box, "4000");
    await user.click(within(section).getByRole("button", { name: "Use" }));
    expect(within(section).getByRole("alert")).toHaveTextContent("1 to 3650");
    await user.clear(box);
    await user.type(box, "45");
    await user.click(within(section).getByRole("button", { name: "Use" }));
    await waitFor(async () => expect(await getRetention(db)).toBe("45d"));
    for (const name of ["90 days", "1 year", "Forever"])
      expect(within(section).getByRole("radio", { name })).not.toBeChecked();
  });

  it("alerts take the person's own days before a bill, its time, the most per day and a pause date", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/notifications");
    await screen.findByRole("list", { name: "Alert types" });
    const puts = () =>
      api.calls.filter((c) => c.method === "PUT" && c.path === "/api/notifications/settings");

    const days = screen.getByLabelText("Your own number of days before, 0 to 14");
    await user.type(days, "15");
    await user.click(days.parentElement?.querySelector("button") as HTMLElement);
    expect(screen.getByRole("alert")).toHaveTextContent("0 to 14");
    await user.clear(days);
    await user.type(days, "10{Enter}");
    await waitFor(() =>
      expect(puts().at(-1)?.body).toEqual({ prefs: { upcoming_expense: { lead_days: 10 } } }),
    );

    const time = screen.getByLabelText("Alert time");
    expect(time).toHaveValue("09:00");
    await user.clear(time);
    await user.type(time, "07:30");
    await user.tab();
    await waitFor(() =>
      expect(puts().at(-1)?.body).toEqual({
        prefs: { upcoming_expense: { time_of_day: "07:30" } },
      }),
    );

    await user.type(screen.getByLabelText("Your own most alerts a day, 1 to 20"), "12{Enter}");
    await waitFor(() =>
      expect(screen.getByText("12 · extras go in one summary")).toBeInTheDocument(),
    );

    await user.type(screen.getByLabelText("Pause until the end of this day"), "2026-10-20");
    await waitFor(() => expect(screen.getByText(/Paused until/)).toBeInTheDocument());
    const last = puts().at(-1)?.body as { settings: { paused_until: string } };
    const until = last.settings.paused_until;
    expect(new Date(until).getTime()).toBe(new Date("2026-10-21T00:00:00").getTime());
  });

  it("the emergency fund takes the person's own target from 1 to 12 months", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const jar = await createGoal(db, {
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
    } as Parameters<typeof createGoal>[1]);
    await db.emergency_fund.put({
      id: "me",
      essentials_cents: 306200,
      target_months: 3,
      monthly_plan_cents: 15400,
      updated_at: "2026-09-01T00:00:00Z",
    });
    await addGoalEvent(db, jar.id, "deposit", "2026-09-15", 62000, new Date());
    installFakeApi({ session: readySession() });
    renderApp(`/goals/${jar.id}`);
    const box = await screen.findByLabelText("Your own target in months, 1 to 12");
    await user.type(box, "13{Enter}");
    expect(await screen.findByText("Pick 1 to 12 months.")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "4{Enter}");
    const milestones = screen.getByRole("region", { name: "Milestones" });
    // 306200 × 4 = 1224800; (1224800 − 62000) ÷ 15400 = 75.5 → 76 months
    await waitFor(() => expect(milestones).toHaveTextContent("4 months$620.00 / $12,248.00"));
    expect(milestones).toHaveTextContent("4-month target in 76 months");
    expect((await db.emergency_fund.get("me"))?.target_months).toBe(4);
  });

  it("a habit runs for the person's own number of days, and a jar cheers at their own milestones", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/goals/new");
    await user.click(await screen.findByRole("radio", { name: "Habit" }));
    await user.click(await screen.findByRole("button", { name: "Change days" }));
    let sheet = await screen.findByRole("dialog", { name: "How many days?" });
    await user.type(within(sheet).getByLabelText("Or any number of days"), "400");
    await user.click(within(sheet).getByRole("button", { name: "Use this" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("1 to 365");
    await user.clear(within(sheet).getByLabelText("Or any number of days"));
    await user.type(within(sheet).getByLabelText("Or any number of days"), "21");
    await user.click(within(sheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change days" })).toHaveTextContent("21 days"),
    );

    await user.click(screen.getByRole("radio", { name: "Save (jar)" }));
    const options = await screen.findByRole("region", { name: "Jar options" });
    await user.type(
      within(options).getByLabelText("Your own milestones, in percent"),
      "90, 10, 50{Enter}",
    );
    expect(
      within(options).getByRole("switch", { name: "Milestones at 10%, 50%, 90%" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create jar" }));
    await screen.findByRole("heading", { level: 1, name: "Travel" });
    const goal = (await db.goals.toArray())[0];
    expect(goal?.milestones_bps).toEqual([1000, 5000, 9000]);
    expect((await db.goal_milestones.toArray()).map((m) => m.bps).sort()).toEqual([
      1000, 5000, 9000,
    ]);

    // On the goal screen: a checkpoint the jar has already passed is recorded quietly.
    await addGoalEvent(db, goal?.id as string, "deposit", "2026-10-10", 30000, new Date());
    await user.click(await screen.findByRole("button", { name: "Change milestones" }));
    sheet = await screen.findByRole("dialog", { name: "Cheer at which milestones?" });
    const own = within(sheet).getByLabelText("Your own milestones, in percent");
    expect(own).toHaveValue("10%, 50%, 90%");
    await user.clear(own);
    await user.type(own, "5, 50{Enter}");
    await waitFor(async () =>
      expect((await db.goals.get(goal?.id as string))?.milestones_bps).toEqual([500, 5000]),
    );
    const rows = await db.goal_milestones.toArray();
    expect(rows.map((m) => [m.bps, m.reached_at]).sort()).toEqual([
      [500, "2026-10-10"],
      [5000, null],
    ]);
    expect((await db.tombstones.toArray()).map((t) => [t.table, t.id]).sort()).toEqual([
      ["goal_milestones", `${goal?.id}:1000`],
      ["goal_milestones", `${goal?.id}:9000`],
    ]);
  });

  it("the 52-week challenge can step up by the person's own amount each week", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/groups/new");
    await user.click(await screen.findByRole("radio", { name: "52-week saving" }));
    await user.type(screen.getByLabelText("Step up each week by"), "5");
    await user.click(screen.getByRole("button", { name: "Use" }));
    expect(
      await screen.findByText("Week 1: $5.00 · week 52: $260.00 · $6,890.00 in all"),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your name, as members will see it"), "Nia");
    await user.click(screen.getByRole("button", { name: "Start challenge" }));
    await screen.findByRole("heading", { level: 1 });
    await waitFor(async () =>
      expect((await db.goals.toArray())[0]).toMatchObject({
        target_cents: 689000,
        cadence: "weekly",
      }),
    );
  });
});
