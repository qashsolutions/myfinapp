/**
 * Paydays from Budget's pay settings, one reading for every screen (October 28, 2026): Home's
 * set-aside, the forecast, goals paid every paycheck and linked cards all go through here.
 * Twice a month and monthly use the days the person picked (`PaySettings.days`, 31 = the last
 * day); pay saved before those choices existed keeps its old reading from `next_payday`.
 */
import type { PayFrequency, PaySettings } from "../../data/db.ts";
import type { PaySchedule } from "../../engine/bridge.ts";

export const LAST_DAY = 31;

/** The suggested pairs and days (owner, October 27, 2026: suggest, then take their own). */
export const TWICE_A_MONTH: Array<[number, number]> = [
  [1, 15],
  [15, LAST_DAY],
];
export const MONTHLY_DAYS = [1, 15, LAST_DAY];

/** The days a pay setting is paid on, for the two month-based kinds; null for weekly kinds. */
export function payDaysOf(
  pay: Pick<PaySettings, "frequency" | "next_payday" | "days">,
): number[] | null {
  if (pay.frequency === "weekly" || pay.frequency === "biweekly") return null;
  if (pay.days?.length) return [...pay.days].sort((a, b) => a - b);
  if (!pay.next_payday) return null;
  const day = Number(pay.next_payday.slice(8, 10));
  if (pay.frequency === "monthly") return [day];
  return day <= 15 ? [day, day + 15] : [day - 15, day]; // saved before the days were asked
}

export function scheduleFor(
  frequency: PayFrequency,
  nextPayday: string | null,
  days: number[] | null | undefined,
): PaySchedule | null {
  if (frequency === "weekly" || frequency === "biweekly")
    return nextPayday
      ? { kind: "every_n_days", anchor: nextPayday, n: frequency === "weekly" ? 7 : 14 }
      : null;
  const picked = payDaysOf({ frequency, next_payday: nextPayday, days });
  return picked ? { kind: "monthly_days", days: picked } : null;
}

export function payScheduleOf(pay: PaySettings | undefined | null): PaySchedule | null {
  return pay ? scheduleFor(pay.frequency, pay.next_payday, pay.days) : null;
}

/** "1st", "15th", "22nd", or "Last day". */
export function dayName(day: number): string {
  if (day === LAST_DAY) return "Last day";
  if (day >= 11 && day <= 13) return `${day}th`;
  return `${day}${{ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th"}`;
}
