import type { StackdDb } from "../../data/db.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { useGoals } from "./useGoals.ts";

/**
 * The count the builder checks at the moment of creating, straight from the table. Every goal
 * counts, in progress, paused or reached; only removed ones don't (owner decision, October 18,
 * 2026: the plan's number is the total kept; moving a jar to templates frees its place).
 */
export async function activeGoalCount(db: StackdDb): Promise<number> {
  return (await db.goals.toArray()).filter((g) => g.status !== "archived").length;
}

export interface GoalCaps {
  /** Jars and goals the plan allows, finished ones included; null = unlimited. */
  max: number | null;
  active: number;
  /** Slots left on the plan; null = unlimited. */
  left: number | null;
  /** How many of the active ones are challenge jars (they count too). */
  challenges: number;
  /** One more cannot be created. */
  full: boolean;
  /** Goals past the cap after a downgrade: kept, shown, read-only (newest first to go). */
  readOnly: Set<string>;
  plan: string;
}

/** The plan's cap on jars and goals (any kind, finished or not; a challenge membership counts as one). */
export function useGoalCaps(): GoalCaps {
  const goals = useGoals();
  const { entitlements } = useEntitlements();
  const max = entitlements.goals_active_max;
  const active = (goals ?? [])
    .filter((g) => g.status !== "archived")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
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
