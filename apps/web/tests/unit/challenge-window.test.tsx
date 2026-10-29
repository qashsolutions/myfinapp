/**
 * Invariant 71 (October 29, 2026): an ended challenge's final board never changes, and a
 * challenge's jar counts only its own period. The owner opened an October dining diet on
 * November 3: the device measured November's spending ("this month"), posted a near-100% figure
 * to the board, and Move money was still live on the ended jar.
 *
 * Every type × every moment on the device, worked out by hand. Open = its first day through its
 * last; before that and after it the jar takes nothing, the screen offers nothing to log or
 * move, and nothing is posted (the server refuses such a post too: test_group_matrix.py).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, type Goal, openDb, seedDefaults } from "../../src/data/db.ts";
import { addGoalEvent, createGoal, moveMoney } from "../../src/features/goals/useGoals.ts";
import { fakeMember, installFakeApi, ME, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

type Template =
  | "monthly_savings"
  | "dining_diet"
  | "no_eat_out_week"
  | "no_spend_weekend"
  | "fifty_two_week";

const TYPES: Record<
  Template,
  { start: string; end: string; goal: Partial<Goal> & Pick<Goal, "kind"> }
> = {
  monthly_savings: {
    start: "2026-10-01",
    end: "2026-10-31",
    goal: { kind: "save", target_cents: 25000 },
  },
  dining_diet: {
    start: "2026-10-01",
    end: "2026-10-31",
    goal: {
      kind: "spend_less",
      target_cents: 10000,
      baseline_cents: 40000,
      category_id: "cat-dining",
    },
  },
  no_eat_out_week: {
    start: "2026-10-20",
    end: "2026-10-26",
    goal: { kind: "habit", target_days: 7 },
  },
  no_spend_weekend: {
    start: "2026-10-24",
    end: "2026-10-25",
    goal: { kind: "habit", target_days: 2 },
  },
  fifty_two_week: {
    start: "2026-10-19",
    end: "2027-10-17",
    goal: { kind: "save", target_cents: 137800, cadence: "weekly" },
  },
};

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The device's own date at each moment (after_end and over_everywhere read the same here: the
// device knows only its own day; the server tells them apart).
const MOMENTS = {
  before_start: (s: string, _e: string) => addDays(s, -1),
  during: (s: string, _e: string) => s,
  last_day: (_s: string, e: string) => e,
  after_end: (_s: string, e: string) => addDays(e, 1),
  over_everywhere: (_s: string, e: string) => addDays(e, 3),
} as const;
type Moment = keyof typeof MOMENTS;
const OPEN: Record<Moment, boolean> = {
  before_start: false,
  during: true,
  last_day: true,
  after_end: false,
  over_everywhere: false,
};

function dining(id: string, date: string, cents: number): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant: "Noodle bar",
    clean_description: "NOODLE BAR",
    raw_description: null,
    category_id: "cat-dining",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  };
}

async function seed(template: Template, groupId: string) {
  const db = openDb("u1");
  await seedDefaults(db);
  const t = TYPES[template];
  const goal = await createGoal(db, {
    title: template,
    target_cents: null,
    target_days: null,
    label: null,
    category_id: null,
    baseline_cents: null,
    ...t.goal,
    start_date: t.start,
    end_date: t.end,
    group_id: groupId,
  });
  const own = await createGoal(db, {
    kind: "save",
    title: "Holiday",
    target_cents: 50000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-01-01",
    end_date: null,
    baseline_cents: null,
    group_id: null,
  });
  // History from its first day (written straight to the table: it happened while it was open).
  const at = `${t.start}T09:00:00Z`;
  if (t.goal.kind === "habit")
    await db.goal_events.add({
      id: `ev-${groupId}`,
      goal_id: goal.id,
      date: t.start,
      type: "checkin",
      amount_cents: null,
      member_id: null,
      created_at: at,
    });
  else if (t.goal.kind === "save")
    await db.goal_events.add({
      id: `ev-${groupId}`,
      goal_id: goal.id,
      date: t.start,
      type: "deposit",
      amount_cents: 5000,
      member_id: null,
      created_at: at,
    });
  else
    await db.entries.bulkAdd([
      dining(`d1-${groupId}`, t.start, 32000), // inside October: $400 usual − $320 = $80 kept back
      dining(`d2-${groupId}`, addDays(t.end, 1), 500), // the next month: never this challenge's
    ]);
  return { db, goal, own };
}

const CASES = (Object.keys(TYPES) as Template[]).flatMap((template) =>
  (Object.keys(MOMENTS) as Moment[]).map((moment) => ({ template, moment })),
);

describe("A challenge's jar at every moment (invariant 71)", () => {
  afterEach(() => vi.useRealTimers());

  it.each(CASES)("$template · $moment", async ({ template, moment }) => {
    const t = TYPES[template];
    const today = MOMENTS[moment](t.start, t.end);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${today}T12:00:00`));
    const groupId = `g-${template}-${moment}`;
    const { db, goal, own } = await seed(template, groupId);
    const api = installFakeApi({
      session: readySession(),
      groups: [
        {
          id: groupId,
          name: template,
          template_key: template,
          start_date: t.start,
          end_date: t.end,
          invite_code: "STK-4F9Q",
          owner_id: "u-maya",
          members: [
            fakeMember("u-maya", "Maya R.", 4000, { is_owner: true }),
            fakeMember(ME, "Nia", 0),
          ],
          ended: moment === "over_everywhere",
        },
      ],
    });
    const open = OPEN[moment];
    renderApp(`/goals/${goal.id}`);
    await screen.findByRole("heading", { level: 1, name: template });

    // What the screen offers.
    await waitFor(async () =>
      expect(await db.computed_results.get(`goal_progress:${goal.id}:${today}`)).toBeDefined(),
    );
    const logRegion = screen.queryByRole("region", { name: "Log money you set aside" });
    const checkIn = screen.queryByRole("region", { name: "Check in" });
    const move = screen.queryByRole("button", { name: "Move money" });
    if (t.goal.kind === "save") {
      expect(Boolean(logRegion)).toBe(open);
      expect(Boolean(move)).toBe(open);
    } else {
      expect(logRegion).toBeNull();
      expect(move).toBeNull();
    }
    if (t.goal.kind === "habit") expect(Boolean(checkIn)).toBe(open);
    else expect(checkIn).toBeNull();
    expect(Boolean(screen.queryByRole("region", { name: "Challenge not started" }))).toBe(
      moment === "before_start",
    );
    expect(Boolean(screen.queryByRole("region", { name: "Challenge ended" }))).toBe(
      moment === "after_end" || moment === "over_everywhere",
    );

    // What is posted to the board: the percentage while it runs, never before or after.
    const posts = () =>
      api.calls.filter((c) => c.method === "PUT" && c.path === `/api/groups/${groupId}/progress`);
    if (open) {
      await waitFor(() => expect(posts().length).toBeGreaterThan(0));
      const sent = (posts().at(-1)?.body ?? {}) as { progress_bps?: number };
      // A dining diet measures its own month: $80 kept back of $100 is 80%, never the next
      // month's spending. Savings: $50 of the target; habits: one day checked in.
      const expected = {
        monthly_savings: 2000,
        dining_diet: 8000,
        no_eat_out_week: 1429,
        no_spend_weekend: 5000,
        fifty_two_week: 363,
      }[template];
      expect(sent.progress_bps).toBe(expected);
    } else {
      await new Promise((r) => setTimeout(r, 50));
      expect(posts()).toEqual([]);
      expect(await db.server_queue.count()).toBe(0);
    }

    // Every path that writes the jar's events asks the same question.
    const write = addGoalEvent(
      db,
      goal.id,
      t.goal.kind === "habit" ? "checkin" : "deposit",
      today,
      t.goal.kind === "habit" ? null : 1000,
    );
    if (open) await expect(write).resolves.toBeDefined();
    else await expect(write).rejects.toThrow("challenge_closed");
    if (t.goal.kind === "save") {
      const out = moveMoney(db, goal.id, own.id, 1000, today);
      const into = moveMoney(db, own.id, goal.id, 1000, today);
      if (open) {
        await expect(out).resolves.toBeUndefined();
        await expect(into).resolves.toBeUndefined();
      } else {
        await expect(out).rejects.toThrow("challenge_closed");
        await expect(into).rejects.toThrow("challenge_closed");
        // Nothing half-written: the move is one transaction.
        expect(await db.goal_events.where("goal_id").equals(own.id).count()).toBe(0);
      }
    }
  });

  it("Home's set-aside tap never lands in an ended challenge's jar", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T12:00:00"));
    const db = openDb("u1");
    await seedDefaults(db);
    await db.settings.put({
      key: "pay",
      value: {
        amount_cents: 240000,
        frequency: "biweekly",
        next_payday: "2026-11-13",
        monthly_cents: 520000,
      },
      updated_at: "2026-10-01T00:00:00Z",
    });
    await db.budgets.add({
      id: "b-nov",
      month: "2026-11",
      method: "50_30_20",
      take_home_cents: 520000,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    });
    const ended = await createGoal(
      db,
      {
        kind: "save",
        title: "October savings",
        target_cents: 25000,
        target_days: null,
        label: null,
        category_id: null,
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        baseline_cents: null,
        group_id: "g-maya",
      },
      new Date("2026-10-01T00:00:00Z"),
    );
    const own = await createGoal(
      db,
      {
        kind: "save",
        title: "Holiday",
        target_cents: 50000,
        target_days: null,
        label: null,
        category_id: null,
        start_date: "2026-11-01",
        end_date: null,
        baseline_cents: null,
        group_id: null,
      },
      new Date("2026-11-01T00:00:00Z"),
    );
    installFakeApi({ session: readySession() });
    renderApp("/");
    const move = await screen.findByRole("region", {
      name: "Payday. Set aside $480.00 before it goes.",
    });
    await user.click(within(move).getByRole("button", { name: "Log $480.00 set aside" }));
    await waitFor(async () =>
      expect(await db.goal_events.where("goal_id").equals(own.id).count()).toBe(1),
    );
    expect(await db.goal_events.where("goal_id").equals(ended.id).count()).toBe(0);
  });
});
