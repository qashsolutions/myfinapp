import type { PathStepId, WeekState } from "../../engine/bridge.ts";
import { formatCents, formatCentsTidy } from "../../lib/format.ts";
import { PATH_THRESHOLDS } from "./config.ts";
import type { PathLayout, WeeklyStreakId } from "./streakSettings.ts";

/** Each step's own words (owner decision, November 19, 2026; spec "Streaks, Your path …"). */
export const STEP_NAMES: Record<PathStepId, string> = {
  setup: "Get set up",
  cushion: "A cushion in checking",
  starter: "Starter fund",
  paid_in_full: "Card paid in full",
  debts: "Debts gone, except the home",
  three_months: "3 months of essentials",
  later: "Growing for later",
};

export function stepName(id: string, layout?: PathLayout): string {
  const own = layout?.names[id as PathStepId];
  return own?.trim() || STEP_NAMES[id as PathStepId] || id;
}

const MILESTONE_NAMES: Record<string, string> = {
  first_jar: "First jar",
  starter_fund: "Starter fund",
  kept_month: "First month kept money",
  all_sorted: "Nothing to sort",
  challenge_done: "Finished a challenge",
  debts_gone: "Debts gone",
};

function tenths(n: number): string {
  return n % 10 === 0 ? String(n / 10) : `${Math.floor(n / 10)}.${n % 10}`;
}

export function milestoneName(id: string): string {
  const streak = /^streak_(\d+)$/.exec(id);
  if (streak) {
    const weeks = Number(streak[1]);
    // Whole years read as years: 52 → "1-year streak", 208 → "4-year streak".
    return weeks % 52 === 0 ? `${weeks / 52}-year streak` : `${weeks}-week streak`;
  }
  const onTime = /^on_time_(\d+)$/.exec(id);
  if (onTime) return `On time ${onTime[1]} times`;
  const jars = /^jars_(\d+)$/.exec(id);
  if (jars) return `${formatCentsTidy(Number(jars[1]) * 100)} in jars`;
  if (id === "paid_in_full") return `Paid in full ${PATH_THRESHOLDS.paid_in_full_months} months`;
  if (id === "three_months") return `${tenths(PATH_THRESHOLDS.runway_tenths ?? 0)} months saved`;
  return MILESTONE_NAMES[id] ?? id;
}

/** A short mark drawn in the milestone's circle. */
export function milestoneMark(id: string): string {
  const streak = /^streak_(\d+)$/.exec(id);
  if (streak) {
    const weeks = Number(streak[1]);
    return weeks % 52 === 0 ? `${weeks / 52}y` : String(weeks);
  }
  const onTime = /^on_time_(\d+)$/.exec(id);
  if (onTime) return `×${onTime[1]}`;
  const jars = /^jars_(\d+)$/.exec(id);
  if (jars) return `$${Number(jars[1]) / 1000}k`;
  const marks: Record<string, string> = {
    first_jar: "1st",
    starter_fund: "$1k",
    kept_month: "In",
    all_sorted: "✓",
    challenge_done: "Ch",
    paid_in_full: `${PATH_THRESHOLDS.paid_in_full_months}×`,
    debts_gone: "0",
    three_months: "3mo",
  };
  return marks[id] ?? "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How far a milestone still is, in plain words; null once there is nothing useful to say. */
export function milestoneToGo(id: string, have: number | null, need: number): string | null {
  if (have === null) return id === "paid_in_full" ? "Needs card statements" : null;
  if (/^streak_/.test(id)) return `${plural(Math.max(0, need - have), "week", "weeks")} to go`;
  if (/^on_time_/.test(id))
    return `${plural(Math.max(0, need - have), "payment", "payments")} to go`;
  if (/^jars_/.test(id)) return `${formatCents(Math.max(0, need - have))} to go`;
  switch (id) {
    case "starter_fund":
      return `${formatCents(Math.max(0, need - have))} to go`;
    case "debts_gone":
      return have > 0 ? `${formatCents(have)} left` : "Add your debts to count";
    case "paid_in_full":
      return `${plural(Math.max(0, need - have), "month", "months")} to go`;
    case "three_months":
      return `${tenths(Math.max(0, need - have))} months to go`;
    case "all_sorted":
      return have > 0 ? `${have} to sort` : "Add an entry first";
    case "first_jar":
      return "Start a jar";
    case "kept_month":
      return "A whole month with money kept";
    case "challenge_done":
      return "Finish a challenge";
    default:
      return null;
  }
}

export const STREAK_NAMES: Record<WeeklyStreakId | "on_time", string> = {
  set_aside: "Set aside",
  on_time: "On time",
  under_plan: "Under plan",
  sorted: "Sorted",
};

/** The line under each weekly streak's count. */
export const STREAK_LINES: Record<WeeklyStreakId, string> = {
  set_aside: "a deposit every week",
  under_plan: "spent on pace with Budget",
  sorted: "every entry has a category",
};

export const STATE_LABEL: Record<WeekState, string> = {
  kept: "kept",
  rest: "rest week",
  paused: "paused",
  skipped: "nothing to count",
  open: "this week, not yet",
  missed: "not kept",
  before: "before it started",
};

export function weeksWord(n: number): string {
  return plural(n, "week", "weeks");
}

/** Your path's word and line, the same on the Streaks tab and the path screen. */
export function pathSummary(
  path: { done: number; total: number },
  next: string | null,
): { word: string; line: string } {
  if (path.total === 0)
    return { word: "Skipped", line: "Every step is skipped. Adjust to show some." };
  if (next) return { word: `${path.done} of ${path.total} done`, line: `Next: ${next}` };
  return { word: "Done", line: "Every step reached. Keep it going." };
}
