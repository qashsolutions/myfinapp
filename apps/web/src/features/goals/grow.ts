/** Words for goals that grow (October 28, 2026; growth.goal_plan). */

import { EngineError, type GrowReach } from "../../engine/bridge.ts";
import { formatCents, formatMonth } from "../../lib/format.ts";

/**
 * The furthest a grows jar's date can be, in months (65 years; owner sign-off, October 29,
 * 2026). Only the date picker's limit: growth.goal_plan checks it and answers `too_far`.
 */
export const GROW_MAX_MONTHS = 780;

/** Plain-language text for growth.goal_plan's error codes. */
export function growMessage(err: unknown): string {
  switch (err instanceof EngineError ? err.code : "") {
    case "too_soon":
    case "deadline_in_past":
      return "Pick a date next month or later to see the monthly amount.";
    case "too_far":
      return "Pick a date within 65 years.";
    case "too_large":
      return "That grows past what can be counted to the cent. Try a lower rate or amount.";
    default:
      return "Pick a date to see the monthly amount.";
  }
}

/** "About $X a month from now · $Y by October 2044". */
export function growLineOf(monthly: number, future: number, date: string): string {
  return `About ${formatCents(monthly)} a month from now · ${formatCents(future)} by ${formatMonth(date)}`;
}

/**
 * What a monthly amount does (growth.goal_reach): "Reaches the cost by March 2043", or "Short by
 * $1,240.00 by October 2044 · reaches it by May 2045" (the later month only when there is one
 * within 65 years).
 */
export function reachLineOf(reach: GrowReach, date: string): string {
  if (reach.reaches_by_target && reach.reach_month)
    return `Reaches the cost by ${formatMonth(`${reach.reach_month}-01`)}`;
  const later =
    reach.reach_month && (reach.reach_months ?? 0) > reach.months
      ? ` · reaches it by ${formatMonth(`${reach.reach_month}-01`)}`
      : "";
  return `Short by ${formatCents(reach.short_by_cents)} by ${formatMonth(date)}${later}`;
}
