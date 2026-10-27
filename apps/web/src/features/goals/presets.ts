/**
 * The blanks' preset choices (docs/spec.md "Custom goals" table; Custom… arrives in 1.5b).
 * Amounts in cents. Deadlines are 3, 6 and 12 months out, computed by the engine.
 */

import type { GoalKind } from "../../data/db.ts";

export const KIND_LABELS: Record<GoalKind, string> = {
  save: "Save (jar)",
  payoff: "Pay off",
  spend_less: "Spend less",
  habit: "Habit",
};

export const WHAT_FOR = ["Travel", "Kids' education", "Emergency fund", "New car"];
export const PAYOFF_WHAT = ["Credit card", "Car loan", "Student loan", "Other debt"]; // proposed
export const HABIT_WHAT = ["no eating out", "no takeout", "cooking at home", "no shopping"]; // proposed
export const AMOUNTS = [50000, 100000, 200000, 500000];
export const SPEND_LESS_AMOUNTS = [5000, 10000, 15000, 20000]; // proposed
export const HABIT_DAYS = [7, 14, 30]; // proposed
export const DEADLINE_MONTHS = [3, 6, 12];
