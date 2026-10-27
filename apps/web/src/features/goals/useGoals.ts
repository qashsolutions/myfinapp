import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import {
  entriesBetween,
  type Goal,
  type GoalEvent,
  type GoalTemplate,
  ignoreClosed,
  newId,
  type StackdDb,
} from "../../data/db.ts";
import { enqueueGroupProgress, flushServerQueue } from "../../data/serverQueue.ts";
import { engine, type GoalProgress, goalProgress, monthBounds } from "../../engine/bridge.ts";

export async function createGoal(
  db: StackdDb,
  goal: Omit<Goal, "id" | "created_at" | "updated_at" | "status">,
  now: Date = new Date(),
): Promise<Goal> {
  const stamp = now.toISOString();
  const row: Goal = {
    ...goal,
    id: newId(),
    status: "active",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.goals.add(row);
  return row;
}

export async function addGoalEvent(
  db: StackdDb,
  goalId: string,
  type: GoalEvent["type"],
  date: string,
  amountCents: number | null,
  now: Date = new Date(),
  memberId: string | null = null,
): Promise<GoalEvent> {
  const row: GoalEvent = {
    id: newId(),
    goal_id: goalId,
    date,
    type,
    amount_cents: amountCents,
    member_id: memberId,
    created_at: now.toISOString(),
  };
  await db.goal_events.add(row);
  return row;
}

/** Spend-less goals compare against this month's spend in their category (through the engine's month view). */
async function periodSpend(db: StackdDb, goal: Goal, asOf: string): Promise<number> {
  if (goal.kind !== "spend_less" || !goal.category_id) return 0;
  const bounds = await monthBounds(asOf);
  const rows = await entriesBetween(db, bounds.start, bounds.end);
  let spent = 0;
  for (const e of rows) {
    if (e.is_transfer || e.not_counted || e.category_id !== goal.category_id) continue;
    spent += e.direction === "out" ? e.amount_cents : -e.amount_cents;
  }
  return spent;
}

export interface GoalWithProgress {
  goal: Goal;
  events: GoalEvent[];
  progress: GoalProgress | null;
}

export function useGoalProgress(
  goal: Goal | null | undefined,
  asOf: string,
): GoalWithProgress | null {
  const { db } = useDb();
  const events = useLiveQuery<GoalEvent[]>(
    async () => (goal ? db.goal_events.where("goal_id").equals(goal.id).toArray() : []),
    [db, goal?.id],
  );
  const [progress, setProgress] = useState<GoalProgress | null>(null);
  const spend = useLiveQuery<number>(
    async () => (goal ? periodSpend(db, goal, asOf) : 0),
    [db, goal, asOf],
  );
  useEffect(() => {
    if (!goal || !events || spend === undefined) return;
    if (goal.is_ongoing) return; // no target: the streak card covers it (fast-follow 3)
    let alive = true;
    void (async () => {
      const p = await goalProgress(
        {
          kind: goal.kind,
          target_cents: goal.target_cents,
          target_days: goal.target_days,
          start_date: goal.start_date,
          end_date: goal.end_date,
          baseline_cents: goal.baseline_cents,
          period_spend_cents: spend,
        },
        [...events]
          .sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
          .map((e) =>
            e.type === "checkin"
              ? { type: e.type, date: e.date }
              : { type: e.type, date: e.date, amount_cents: e.amount_cents },
          ),
        asOf,
      );
      if (!alive) return;
      setProgress(p);
      // A reached goal stops counting toward the plan's cap (owner decision, October 18, 2026);
      // it goes back to active if it drops below its target again.
      const reached = p.status === "reached";
      if ((goal.status === "active" && reached) || (goal.status === "reached" && !reached))
        await db.goals.update(goal.id, {
          status: reached ? "reached" : "active",
          updated_at: new Date().toISOString(),
        });
      // A challenge member appears on the board after their first deposit, never at 0% by default.
      // Habits and savings appear on the board after their first event; a dining diet as soon
      // as there is spending to measure. A percentage is never negative on the board.
      if (goal.group_id && (events.length > 0 || (goal.kind === "spend_less" && spend > 0)))
        void postGroupProgress(db, goal.group_id, Math.max(0, p.progress_bps ?? 0)).catch(() => {});
      await db.computed_results.put({
        id: `goal_progress:${goal.id}:${asOf}`,
        kind: "goal_progress",
        as_of: asOf,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: p,
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, goal, events, asOf, spend]);
  if (!goal || !events) return null;
  return {
    goal,
    events: [...events].sort(
      (a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at),
    ),
    progress,
  };
}

const lastPosted = new Map<string, number>();

/** A challenge goal's percentage goes to the server (never the amount), once per change. */
async function postGroupProgress(db: StackdDb, groupId: string, progressBps: number) {
  if (lastPosted.get(groupId) === progressBps) return;
  lastPosted.set(groupId, progressBps);
  await enqueueGroupProgress(db, groupId, progressBps);
  await flushServerQueue(db);
}

export function useGoals(): Goal[] | undefined {
  const { db } = useDb();
  return useLiveQuery(
    async () =>
      (await db.goals.toArray())
        .filter((g) => g.status !== "archived")
        .sort(
          (a, b) =>
            (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        ),
    [db],
  );
}

// fast-follow 3: custom-goal extras

/** Jar split: money leaves one jar and lands in another, as two events with one stamp. */
export async function moveMoney(
  db: StackdDb,
  fromId: string,
  toId: string,
  cents: number,
  date: string,
  memberId: string | null = null,
  now: Date = new Date(),
): Promise<void> {
  if (cents <= 0 || fromId === toId) throw new Error("invalid_move");
  await db.transaction("rw", db.goal_events, async () => {
    await addGoalEvent(db, fromId, "withdrawal", date, cents, now, memberId);
    await addGoalEvent(db, toId, "deposit", date, cents, now, memberId);
  });
}

/**
 * New money put into jars: deposits, minus the deposit half of each Move money (a withdrawal
 * from one jar written with it), since moving between jars sets nothing new aside.
 */
export function newMoneyIn(events: GoalEvent[]): GoalEvent[] {
  const moves = new Set(
    events
      .filter((e) => e.type === "withdrawal")
      .map((e) => `${e.created_at}|${e.date}|${e.amount_cents}`),
  );
  return events.filter((e) => {
    if (e.type !== "deposit") return false;
    const key = `${e.created_at}|${e.date}|${e.amount_cents}`;
    if (!moves.has(key)) return true;
    moves.delete(key); // one withdrawal pairs with one deposit
    return false;
  });
}

export async function setPaused(
  db: StackdDb,
  goal: Goal,
  paused: boolean,
  today: string,
): Promise<void> {
  const pauses = [...(goal.pauses ?? [])];
  if (paused) pauses.push({ start: today, end: null });
  else {
    for (let i = pauses.length - 1; i >= 0; i--) {
      const open = pauses[i];
      if (open && open.end === null) {
        pauses[i] = { ...open, end: today };
        break;
      }
    }
  }
  await db.goals.update(goal.id, {
    paused_at: paused ? today : null,
    pauses,
    updated_at: new Date().toISOString(),
  });
}

export async function setPriorities(db: StackdDb, orderedIds: string[]): Promise<void> {
  const stamp = new Date().toISOString();
  await db.transaction("rw", db.goals, async () => {
    for (const [i, id] of orderedIds.entries())
      await db.goals.update(id, { priority: i, updated_at: stamp });
  });
}

/** Milestone rows for a goal's checkpoints (created with the goal; stamped when reached). */
export async function ensureMilestones(
  db: StackdDb,
  goal: Goal,
  targets: Array<{ bps: number; target_cents: number }>,
): Promise<void> {
  for (const t of targets) {
    const id = `${goal.id}:${t.bps}`;
    if (!(await db.goal_milestones.get(id)))
      await db.goal_milestones.add({
        id,
        goal_id: goal.id,
        bps: t.bps,
        label: `${t.bps / 100}%`,
        target_cents: t.target_cents,
        reached_at: null,
      });
  }
}

export async function stampMilestones(
  db: StackdDb,
  goal: Goal,
  results: Array<{ bps: number; target_cents: number; reached: boolean }>,
  today: string,
): Promise<string[]> {
  // Rows for every checkpoint (a goal may have arrived from another device), stamping the reached ones.
  await ensureMilestones(db, goal, results);
  const stamped: string[] = [];
  for (const r of results) {
    if (!r.reached) continue;
    const row = await db.goal_milestones.get(`${goal.id}:${r.bps}`);
    if (row && !row.reached_at) {
      await db.goal_milestones.update(row.id, { reached_at: today });
      stamped.push(row.id);
    }
  }
  return stamped;
}

export function templatePayload(goal: Goal, months: number | null): GoalTemplate["payload"] {
  return {
    kind: goal.kind,
    title: goal.title,
    target_cents: goal.target_cents,
    months,
    cadence: goal.cadence ?? null,
    per_period_cents: goal.per_period_cents ?? null,
    is_ongoing: goal.is_ongoing ?? false,
    why_text: goal.why_text ?? null,
    milestones_bps: goal.milestones_bps ?? [],
  };
}

export async function saveTemplate(
  db: StackdDb,
  name: string,
  payload: GoalTemplate["payload"],
  now: Date = new Date(),
): Promise<GoalTemplate> {
  const row: GoalTemplate = { id: newId(), name, payload, created_at: now.toISOString() };
  await db.goal_templates.add(row);
  return row;
}

export function useTemplates(): GoalTemplate[] | undefined {
  const { db } = useDb();
  return useLiveQuery(() => db.goal_templates.orderBy("created_at").toArray(), [db]);
}
