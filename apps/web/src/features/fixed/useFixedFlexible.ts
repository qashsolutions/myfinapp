import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { covers, useCoverageStart } from "../../data/coverage.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type Category,
  counted,
  type Entry,
  entriesBetween,
  ignoreClosed,
  type StackdDb,
} from "../../data/db.ts";
import {
  addMonths,
  engine,
  type FixedFlexible,
  type FixedOverrides,
  type FlexRuleEntry,
  fixedFlexible,
  monthBounds,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { useLookups } from "../entries/useEntries.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";

/** An entry as `cashflow.fixed_flexible` takes it: its run mark and its category's bucket. */
export function toFlexEntry(e: Entry, categories: Map<string, Category>): FlexRuleEntry {
  const category = e.category_id ? categories.get(e.category_id) : undefined;
  return {
    ...toRuleEntry(e, categories),
    is_recurring: e.is_recurring,
    bucket: category?.kind === "expense" ? (category.bucket ?? null) : null,
  };
}

export interface FixedFlexibleView {
  /** The month asked for: the 1st through today, or the whole month when it is past. */
  current: FixedFlexible;
  /** The same days of the month before (the whole month before when this one is past). */
  before: FixedFlexible;
  /** Whether the data covers the whole month before: only then is it compared (invariant 51). */
  compared: boolean;
  /**
   * The kept rate for the `monthsBack` whole months before and this one, oldest first; a month
   * the data covers only part of is left out (invariant 51).
   */
  months: Array<{ start: string; result: FixedFlexible }>;
  word: FixedWord;
}

export type FixedWord = "Up" | "Down" | "Steady" | "Kept" | "Over" | "Start";

/**
 * docs/spec.md "Fixed vs flexible": Up / Down / Steady compare the kept rate with the same days
 * of last month; without money in on either side, Kept / Over by the sign of Kept; Start when
 * the month has nothing.
 */
export function fixedWord(
  current: FixedFlexible,
  before: FixedFlexible,
  compared = true,
): FixedWord {
  if (current.in_cents === 0 && current.out_cents === 0) return "Start";
  const now = current.kept_rate_bps;
  const then = compared ? before.kept_rate_bps : null;
  if (now === null || then === null) return current.kept_cents < 0 ? "Over" : "Kept";
  return now > then ? "Up" : now < then ? "Down" : "Steady";
}

/** `settings` key of the person's own fixed / flexible call per category (October 29, 2026). */
export const OVERRIDE_KEY = "fixed.override";

/** A saved override map made safe: only "fixed" / "flexible" values survive. */
export function readOverrides(raw: unknown): FixedOverrides {
  const out: FixedOverrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, call] of Object.entries(raw as Record<string, unknown>))
    if (call === "fixed" || call === "flexible") out[id] = call;
  return out;
}

/** The person's overrides, live; undefined while reading. */
export function useFixedOverrides(): FixedOverrides | undefined {
  const { db } = useDb();
  return useLiveQuery(
    async () => readOverrides((await db.settings.get(OVERRIDE_KEY))?.value),
    [db],
  );
}

/** Sets one category's call, or clears it (`null`: back to what the bills say). */
export async function setOverride(
  db: StackdDb,
  categoryId: string,
  call: "fixed" | "flexible" | null,
): Promise<void> {
  const now = readOverrides((await db.settings.get(OVERRIDE_KEY))?.value);
  if (call === null) delete now[categoryId];
  else now[categoryId] = call;
  await db.settings.put({ key: OVERRIDE_KEY, value: now, updated_at: new Date().toISOString() });
}

/**
 * Fixed vs flexible for the month containing `asOf`, from the engine, live with the database.
 * `monthsBack` whole months before it join the kept-rate bars (3 on the screen, 5 on Your month).
 */
export function useFixedFlexible(
  asOf: string,
  today: string,
  monthsBack = 3,
): FixedFlexibleView | undefined {
  const { db } = useDb();
  const lookups = useLookups();
  const overrides = useFixedOverrides();
  const coverage = useCoverageStart();
  const [span, setSpan] = useState<{
    start: string;
    end: string;
    beforeStart: string;
    beforeEnd: string;
    months: Array<{ start: string; end: string }>;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const month = await monthBounds(asOf);
      const past = compareText(month.end, today) < 0;
      const end = past ? month.end : today;
      const beforeStart = await addMonths(month.start, -1);
      const beforeEnd = past ? (await monthBounds(beforeStart)).end : await addMonths(end, -1);
      const months = [];
      for (let k = monthsBack; k >= 1; k--) {
        const start = await addMonths(month.start, -k);
        months.push({ start, end: (await monthBounds(start)).end });
      }
      months.push({ start: month.start, end });
      if (alive) setSpan({ start: month.start, end, beforeStart, beforeEnd, months });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf, today, monthsBack]);

  const entries = useLiveQuery(
    () =>
      span
        ? entriesBetween(db, span.months[0]?.start ?? span.start, span.end)
        : Promise.resolve(undefined),
    [db, span],
  );
  const [view, setView] = useState<FixedFlexibleView | undefined>(undefined);
  useEffect(() => {
    if (!span || !entries || !lookups || !overrides || coverage === undefined) return;
    let alive = true;
    void (async () => {
      const rows = counted(entries).map((e) => toFlexEntry(e, lookups.categories));
      const current = await fixedFlexible(span.start, span.end, rows, overrides);
      const before = await fixedFlexible(span.beforeStart, span.beforeEnd, rows, overrides);
      const months = [];
      for (const m of span.months)
        if (m.start === span.start || covers(coverage, m.start))
          months.push({
            start: m.start,
            result: await fixedFlexible(m.start, m.end, rows, overrides),
          });
      const compared = covers(coverage, span.beforeStart);
      await db.computed_results.put({
        id: `fixed_flexible:${span.end}`,
        kind: "fixed_flexible",
        as_of: span.end,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: current,
        computed_at: new Date().toISOString(),
      });
      if (alive)
        setView({
          current,
          before,
          compared,
          months,
          word: fixedWord(current, before, compared),
        });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, span, entries, lookups, overrides, coverage]);
  return view;
}
