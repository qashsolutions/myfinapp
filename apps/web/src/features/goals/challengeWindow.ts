import type { Goal } from "../../data/db.ts";
import { compareText } from "../../lib/order.ts";

/**
 * A challenge's own jar once the challenge is over (its last day, the group's `end_date`, is
 * before today on this device; invariant 56). It stays kept and shown with the final board, takes
 * no deposits or check-ins, and no longer holds a place on the plan.
 */
export function challengeEnded(goal: Pick<Goal, "group_id" | "end_date">, today: string): boolean {
  return goal.group_id !== null && goal.end_date !== null && compareText(goal.end_date, today) < 0;
}

/** A challenge's jar before its first day (the group's `start_date` is after today here). */
export function challengeNotStarted(
  goal: Pick<Goal, "group_id" | "start_date">,
  today: string,
): boolean {
  return goal.group_id !== null && compareText(goal.start_date, today) > 0;
}

/**
 * Whether money or check-ins may go into this goal today (invariant 71): any goal of the
 * person's own, and a challenge's jar from its first day through its last. Every path that
 * writes a challenge's events (the goal screen, Move money, Home's set aside and catch-up) and
 * the device's posts to the board ask this one question.
 */
export function challengeOpen(
  goal: Pick<Goal, "group_id" | "start_date" | "end_date">,
  today: string,
): boolean {
  return !challengeNotStarted(goal, today) && !challengeEnded(goal, today);
}
