import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Category, counted, type Entry, entriesBetween, ignoreClosed } from "../../data/db.ts";
import {
  addMonths,
  engine,
  type FixedFlexible,
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
  /** The kept rate for the 3 whole months before and this one, oldest first. */
  months: Array<{ start: string; result: FixedFlexible }>;
  word: FixedWord;
}

export type FixedWord = "Up" | "Down" | "Steady" | "Kept" | "Over" | "Start";

/**
 * docs/spec.md "Fixed vs flexible": Up / Down / Steady compare the kept rate with the same days
 * of last month; without money in on either side, Kept / Over by the sign of Kept; Start when
 * the month has nothing.
 */
export function fixedWord(current: FixedFlexible, before: FixedFlexible): FixedWord {
  if (current.in_cents === 0 && current.out_cents === 0) return "Start";
  const now = current.kept_rate_bps;
  const then = before.kept_rate_bps;
  if (now === null || then === null) return current.kept_cents < 0 ? "Over" : "Kept";
  return now > then ? "Up" : now < then ? "Down" : "Steady";
}

/** Fixed vs flexible for the month containing `asOf`, from the engine, live with the database. */
export function useFixedFlexible(asOf: string, today: string): FixedFlexibleView | undefined {
  const { db } = useDb();
  const lookups = useLookups();
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
      for (const k of [3, 2, 1]) {
        const start = await addMonths(month.start, -k);
        months.push({ start, end: (await monthBounds(start)).end });
      }
      months.push({ start: month.start, end });
      if (alive) setSpan({ start: month.start, end, beforeStart, beforeEnd, months });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf, today]);

  const entries = useLiveQuery(
    () =>
      span
        ? entriesBetween(db, span.months[0]?.start ?? span.start, span.end)
        : Promise.resolve(undefined),
    [db, span],
  );
  const [view, setView] = useState<FixedFlexibleView | undefined>(undefined);
  useEffect(() => {
    if (!span || !entries || !lookups) return;
    let alive = true;
    void (async () => {
      const rows = counted(entries).map((e) => toFlexEntry(e, lookups.categories));
      const current = await fixedFlexible(span.start, span.end, rows);
      const before = await fixedFlexible(span.beforeStart, span.beforeEnd, rows);
      const months = [];
      for (const m of span.months)
        months.push({ start: m.start, result: await fixedFlexible(m.start, m.end, rows) });
      await db.computed_results.put({
        id: `fixed_flexible:${span.end}`,
        kind: "fixed_flexible",
        as_of: span.end,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: current,
        computed_at: new Date().toISOString(),
      });
      if (alive) setView({ current, before, months, word: fixedWord(current, before) });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, span, entries, lookups]);
  return view;
}
