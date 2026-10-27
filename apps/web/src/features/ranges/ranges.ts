/**
 * Time ranges (docs/spec.md "Time ranges"; owner decision, October 25, 2026, replacing 1M · 3M ·
 * 6M · 1Y · All): Month · Quarter · Year · YTD, plus Next where a screen can look forward.
 * Month is this month so far, Quarter the last 3 months, Year the last 12, YTD January 1 to today;
 * "Earlier" steps a whole period back at a time (a YTD step back is the whole year before), so
 * all of a person's history stays reachable. Dates come from the engine's date rules; this file
 * only picks which ones.
 */

import { useState } from "react";
import { addDays, addMonths, type SeriesStepKind } from "../../engine/bridge.ts";

export const RANGES = ["Month", "Quarter", "Year", "YTD"] as const;
export type Range = (typeof RANGES)[number];
/** A picker that can also look forward (Money in & out). */
export type RangeChoice = Range | "Next";

const SPAN: Record<Exclude<Range, "YTD">, number> = { Month: 1, Quarter: 3, Year: 12 };

export const RANGE_NAME: Record<RangeChoice, string> = {
  Month: "this month",
  Quarter: "the last 3 months",
  Year: "the last 12 months",
  YTD: "this year so far",
  Next: "the next 30 days",
};

/** Ranges saved before October 25, 2026 map onto the new ones. */
const LEGACY: Record<string, Range> = {
  "1M": "Month",
  "3M": "Quarter",
  "6M": "Quarter",
  "1Y": "Year",
  All: "Year",
};

export interface RangeBounds {
  range: Range;
  /** Whole periods stepped back from now (0 = the current one). */
  back: number;
  start: string;
  end: string;
  /** Calendar months the range touches (October 20 to … counts this month as one). */
  months: number;
  step: SeriesStepKind;
  /** The period just before, for the comparison: day for day while current, else the whole one. */
  previous: { start: string; end: string } | null;
  /** "October 2026", "Aug – Oct 2026", "Nov 2025 – Oct 2026", "2026 so far", "2025". */
  label: string;
  /** Entries exist before this range's start, so "Earlier" has somewhere to go. */
  hasEarlier: boolean;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthsTouched(start: string, end: string): number {
  const [sy, sm] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const [ey, em] = [Number(end.slice(0, 4)), Number(end.slice(5, 7))];
  return (ey - sy) * 12 + (em - sm) + 1;
}

function periodLabel(range: Range, back: number, start: string, end: string): string {
  const [sy, sm] = [start.slice(0, 4), Number(start.slice(5, 7))];
  const [ey, em] = [end.slice(0, 4), Number(end.slice(5, 7))];
  if (range === "YTD") return back === 0 ? `${sy} so far` : sy;
  if (range === "Month") return `${LONG[sm - 1]} ${sy}`;
  const from = sy === ey ? SHORT[sm - 1] : `${SHORT[sm - 1]} ${sy}`;
  return `${from} – ${SHORT[em - 1]} ${ey}`;
}

export async function rangeBounds(
  range: Range,
  today: string,
  firstDate: string | null,
  back = 0,
): Promise<RangeBounds> {
  let start: string;
  let end: string;
  let previous: { start: string; end: string };
  if (range === "YTD") {
    const year = Number(today.slice(0, 4)) - back;
    start = `${year}-01-01`;
    end = back === 0 ? today : `${year}-12-31`;
    previous =
      back === 0
        ? { start: `${year - 1}-01-01`, end: await addMonths(today, -12) }
        : { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` };
  } else {
    const n = SPAN[range];
    const current = await addMonths(monthStart(today), -(n - 1));
    start = await addMonths(current, -n * back);
    end = back === 0 ? today : await addDays(await addMonths(start, n), -1);
    previous =
      back === 0
        ? { start: await addMonths(start, -n), end: await addMonths(end, -n) }
        : { start: await addMonths(start, -n), end: await addDays(start, -1) };
  }
  const months = monthsTouched(start, end);
  const step: SeriesStepKind = months <= 3 ? "week" : months > 36 ? "quarter" : "month";
  return {
    range,
    back,
    start,
    end,
    months,
    step,
    previous,
    label: periodLabel(range, back, start, end),
    hasEarlier: firstDate !== null && firstDate < start,
  };
}

/** Net worth's dates: the day before the range starts, each month end inside it, and its end. */
export async function netWorthDates(bounds: RangeBounds): Promise<string[]> {
  const dates = [await addDays(bounds.start, -1)];
  let next = await addMonths(bounds.start, 1);
  while (next <= bounds.end) {
    dates.push(await addDays(next, -1));
    next = await addMonths(next, 1);
  }
  if (dates[dates.length - 1] !== bounds.end) dates.push(bounds.end);
  return dates;
}

export interface RangeState<R extends string> {
  range: R;
  setRange: (r: R) => void;
  back: number;
  setBack: (n: number) => void;
}

/** Each screen remembers its range on this device only; stepping back is for this visit. */
export function useRange<R extends RangeChoice = Range>(
  screen: string,
  fallback: R = "Month" as R,
  allowed: readonly string[] = RANGES,
): RangeState<R> {
  const key = `stackd.range.${screen}`;
  const [range, setRangeState] = useState<R>(() => {
    try {
      const saved = localStorage.getItem(key) ?? "";
      const mapped = LEGACY[saved] ?? saved;
      return allowed.includes(mapped) ? (mapped as R) : fallback;
    } catch {
      return fallback;
    }
  });
  const [back, setBack] = useState(0);
  return {
    range,
    back,
    setBack: (n) => setBack(Math.max(0, n)),
    setRange: (r) => {
      setRangeState(r);
      setBack(0);
      try {
        localStorage.setItem(key, r);
      } catch {
        /* private mode: the range is still used this visit */
      }
    },
  };
}
