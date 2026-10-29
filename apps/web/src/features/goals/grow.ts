/** Words for goals that grow (October 28, 2026; growth.goal_plan). */

import { EngineError } from "../../engine/bridge.ts";
import { formatCents, formatMonth } from "../../lib/format.ts";

/** Plain-language text for growth.goal_plan's error codes. */
export function growMessage(err: unknown): string {
  switch (err instanceof EngineError ? err.code : "") {
    case "too_soon":
    case "deadline_in_past":
      return "Pick a date next month or later to see the monthly amount.";
    case "too_far":
      return "Pick a date within 100 years.";
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
