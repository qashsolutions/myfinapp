import insightsConfig from "@stackd/rules/insights";

/**
 * Streaks, Your path and milestones thresholds (config/insights.yaml `streaks`, `path`,
 * `milestones`; signed off by the owner, November 19, 2026). Never a number in a component.
 */
const config = insightsConfig as unknown as {
  streaks: { weeks_shown: number; rest_weeks_per_quarter: number; history_months: number };
  path: {
    cushion_cents: number;
    starter_cents: number;
    paid_in_full_months: number;
    runway_tenths: number;
  };
  milestones: { streak_weeks: number[]; on_time_payments: number[]; jars_cents: number[] };
};

export const WEEKS_SHOWN = config.streaks.weeks_shown;
export const REST_QUOTA = config.streaks.rest_weeks_per_quarter;
/** Streaks count at most this far back (4 years, owner decision November 20, 2026). */
export const HISTORY_MONTHS = config.streaks.history_months;
export const PATH_THRESHOLDS: Record<string, number> = { ...config.path };
export const MILESTONE_THRESHOLDS: Record<string, number | number[]> = {
  ...config.milestones,
  starter_cents: config.path.starter_cents,
  paid_in_full_months: config.path.paid_in_full_months,
  runway_tenths: config.path.runway_tenths,
};
