import insightsConfig from "@stackd/rules/insights";

/** Insight thresholds live in versioned config (config/insights.yaml), never in components. */
export const THRESHOLDS: Record<string, number> = (
  insightsConfig as { thresholds: Record<string, number> }
).thresholds;
