import type { Goal, StackdDb } from "../../data/db.ts";
import { todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { useGoals } from "./useGoals.ts";

/**
 * A challenge's own jar once the challenge is over (its last day, the group's `end_date`, is
 * before today on this device; invariant 56). It stays kept and shown with the final board, takes
 * no deposits or check-ins, and no longer holds a place on the plan.
 */
export function challengeEnded(goal: Pick<Goal, "group_id" | "end_date">, today: string): boolean {
  return goal.group_id !== null && goal.end_date !== null && compareText(goal.end_date, today) < 0;
}

/** What holds a place on the plan: every goal kept, except an ended challenge's jar. */
function holdsPlace(goal: Goal, today: string): boolean {
  return goal.status !== "archived" && !challengeEnded(goal, today);
}

/**
 * The count the builder checks at the moment of creating, straight from the table. Every goal
 * counts, in progress, paused or reached; only removed ones and ended challenges' jars don't
 * (owner decision, October 18, 2026: the plan's number is the total kept; moving a jar to
 * templates frees its place; October 29, 2026: a challenge that ended frees its place).
 */
export async function activeGoalCount(db: StackdDb, today = todayIso()): Promise<number> {
  return (await db.goals.toArray()).filter((g) => holdsPlace(g, today)).length;
}

export interface GoalCaps {
  /** Jars and goals the plan allows, finished ones included; null = unlimited. */
  max: number | null;
  active: number;
  /** Slots left on the plan; null = unlimited. */
  left: number | null;
  /** How many of the active ones are challenge jars (they count too, until the challenge ends). */
  challenges: number;
  /** One more cannot be created. */
  full: boolean;
  /** Goals past the cap after a downgrade: kept, shown, read-only (newest first to go). */
  readOnly: Set<string>;
  plan: string;
}

/** The plan's cap on jars and goals (any kind, finished or not; a running challenge counts as one). */
export function useGoalCaps(): GoalCaps {
  const goals = useGoals();
  const { entitlements } = useEntitlements();
  const today = todayIso();
  const max = entitlements.goals_active_max;
  const active = (goals ?? [])
    .filter((g) => holdsPlace(g, today))
    .sort((a, b) => compareText(a.created_at, b.created_at) || compareText(a.id, b.id));
  const readOnly = new Set(max === null ? [] : active.slice(max).map((g) => g.id));
  return {
    max,
    active: active.length,
    left: max === null ? null : Math.max(0, max - active.length),
    challenges: active.filter((g) => g.group_id !== null).length,
    full: max !== null && active.length >= max,
    readOnly,
    plan: entitlements.plan,
  };
}
