/**
 * The blanks' suggested choices (docs/spec.md "Custom goals" table; owner sign-off October 27,
 * 2026). Every blank also takes the person's own value.
 * Amounts in cents. Deadlines are 3, 6 and 12 months out, computed by the engine.
 */

import type { GoalKind } from "../../data/db.ts";

export const KIND_LABELS: Record<GoalKind, string> = {
  save: "Save (jar)",
  payoff: "Pay off",
  spend_less: "Spend less",
  habit: "Habit",
};

export const WHAT_FOR = ["Travel", "Kids' education", "Emergency fund", "New car", "A home"];

/**
 * Goals that grow (October 28, 2026; proposed, awaiting owner sign-off): how fast the cost rises
 * and how fast savings grow, each a year. Kids' education and A home turn "Grows over time" on.
 */
export const GROW_RISE_BPS = [300, 500, 700];
export const GROW_RETURN_BPS = [300, 500, 700];
export const DEFAULT_RISE_BPS = 300;
export const DEFAULT_RETURN_BPS = 500; // the same middle rate as Later
export const GROWS_WHAT: Record<string, number> = { "Kids' education": 500, "A home": 300 };
export const PAYOFF_WHAT = ["Credit card", "Car loan", "Student loan", "Other debt"];
export const HABIT_WHAT = ["no eating out", "no takeout", "cooking at home", "no shopping"];
export const AMOUNTS = [50000, 100000, 200000, 500000];
export const SPEND_LESS_AMOUNTS = [5000, 10000, 15000, 20000];
export const HABIT_DAYS = [7, 14, 30];
export const DEADLINE_MONTHS = [3, 6, 12];

/** Milestones on by default: quarter checkpoints, in basis points. */
export const DEFAULT_MILESTONES_BPS = [2500, 5000, 7500];
/** Suggested checkpoint sets; the person can type their own (up to five percents). */
export const MILESTONE_SETS: number[][] = [
  DEFAULT_MILESTONES_BPS,
  [5000],
  [2000, 4000, 6000, 8000],
];
