/**
 * Streaks over long histories (November 20, 2026; invariant 94): a week, a month, a year and
 * five years of data, a year boundary, a leap February, and a time budget so the rules stay
 * fast on years of entries. Expected counts are worked out by hand in each comment; the same
 * cases run in Python (services/rules/tests/test_streaks_long.py).
 */
import { describe, expect, it } from "vitest";
import { addDays, iso, parseDate } from "./dates.ts";
import { sortedWeeks, underPlan, weekly } from "./streaks.ts";
import { compareText } from "./text.ts";

/** One date a week (the Tuesday) from a Monday through another Monday, inclusive. */
function tuesdays(fromMonday: string, toMonday: string, skip: string[] = []): string[] {
  const out: string[] = [];
  let d = parseDate(fromMonday);
  const last = iso(parseDate(toMonday));
  while (compareText(iso(d), last) <= 0) {
    if (!skip.includes(iso(d))) out.push(iso(addDays(d, 1)));
    d = addDays(d, 7);
  }
  return out;
}

function everyDay(from: string, days: number, perDay: number) {
  const out: Array<{ date: string; direction: "out"; amount_cents: number; sorted: boolean }> = [];
  let d = parseDate(from);
  for (let i = 0; i < days; i++) {
    for (let k = 0; k < perDay; k++)
      out.push({ date: iso(d), direction: "out", amount_cents: 100, sorted: true });
    d = addDays(d, 1);
  }
  return out;
}

describe("streaks over time", () => {
  it("after one week: the first deposit counts at once", () => {
    const s = weekly("2026-11-19", "2026-11-16", ["2026-11-17"], 2, 8);
    expect([s.current, s.best, s.this_week, s.last_week]).toEqual([1, 1, "kept", null]);
  });

  it("after a month: five weeks in a row (Oct 19 through Nov 16)", () => {
    const met = tuesdays("2026-10-19", "2026-11-16");
    const s = weekly("2026-11-19", "2026-10-19", met, 2, 8);
    expect([s.current, s.best, s.kept_weeks]).toEqual([5, 5, 5]);
  });

  it("after a year: 53 Mondays from Nov 17, 2025; a rest week holds without adding", () => {
    const met = tuesdays("2025-11-17", "2026-11-16", ["2026-05-04"]);
    const s = weekly("2026-11-19", "2025-11-17", met, 2, 8, ["2026-05-04"]);
    // 53 weeks, one of them a rest: 52 kept, the run unbroken.
    expect([s.current, s.best, s.kept_weeks]).toEqual([52, 52, 52]);
  });

  it("after a year with a miss and no rest: the run starts again, the best stays", () => {
    const met = tuesdays("2025-11-17", "2026-11-16", ["2026-05-04"]);
    const s = weekly("2026-11-19", "2025-11-17", met, 2, 8);
    // Nov 17, 2025 … Apr 27, 2026 is 24 weeks; May 11 … Nov 16, 2026 is 28.
    expect([s.current, s.best]).toEqual([28, 28]);
  });

  it("after five years: 261 weeks from Nov 22, 2021 (1,826 days, one leap day, to Nov 16, 2026)", () => {
    const met = tuesdays("2021-11-22", "2026-11-16");
    const s = weekly("2026-11-19", "2021-11-22", met, 2, 8);
    expect([s.current, s.best, met.length]).toEqual([261, 261, 261]);
  });

  it("five years of entries stay fast and every whole week counts", () => {
    // 10 entries a day from Nov 22, 2021: 1,824 days to Nov 19, 2026 = 18,240 entries.
    const entries = everyDay("2021-11-22", 1824, 10);
    const plans: Array<{ month: string; planned_cents: number }> = [];
    for (let y = 2021; y <= 2026; y++)
      for (let m = 1; m <= 12; m++)
        plans.push({ month: `${y}-${String(m).padStart(2, "0")}`, planned_cents: 10_000_000 });
    let t = performance.now();
    const under = underPlan("2026-11-19", "2021-11-22", plans, entries);
    const underMs = performance.now() - t;
    t = performance.now();
    const sorted = sortedWeeks("2026-11-19", "2021-11-22", entries);
    const sortedMs = performance.now() - t;
    // 261 weeks in all; this one is not whole yet, so 260 count.
    expect(under.met).toHaveLength(260);
    expect(sorted.met).toHaveLength(260);
    expect(underMs).toBeLessThan(250);
    expect(sortedMs).toBeLessThan(250);
  });

  it("a week across New Year is judged on January's plan for January's days", () => {
    // Week Dec 28, 2026 – Jan 3, 2027 ends in January: 31,000 × 3 ÷ 31 = 3,000 allowed;
    // December's spending is December's.
    const r = underPlan(
      "2027-01-05",
      "2026-12-28",
      [{ month: "2027-01", planned_cents: 31000 }],
      [
        { date: "2026-12-30", direction: "out", amount_cents: 99999 },
        { date: "2027-01-02", direction: "out", amount_cents: 3000 },
      ],
    );
    expect(r).toEqual({ met: ["2026-12-28"], skips: [] });
  });

  it("a leap February has 29 days", () => {
    // Week Feb 21–27, 2028: 29,000 × 27 ÷ 29 = 27,000 allowed.
    const plans = [{ month: "2028-02", planned_cents: 29000 }];
    const at = (cents: number) =>
      underPlan("2028-02-29", "2028-02-21", plans, [
        { date: "2028-02-27", direction: "out", amount_cents: cents },
      ]);
    expect(at(27000).met).toEqual(["2028-02-21"]);
    expect(at(27001).met).toEqual([]);
  });
});
