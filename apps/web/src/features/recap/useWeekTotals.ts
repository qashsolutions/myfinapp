import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { covers, useCoverageStart } from "../../data/coverage.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { counted, type Entry, entriesBetween, ignoreClosed } from "../../data/db.ts";
import { addDays, engine, type MonthTotals, netChange, periodTotals } from "../../engine/bridge.ts";
import { useLookups } from "../entries/useEntries.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";

export interface WeekView {
  /** the seven days ending on `asOf` */
  start: string | null;
  end: string;
  entries: Entry[] | undefined;
  totals: MonthTotals | null;
  /** the seven days before those */
  previous: MonthTotals | null;
  /** this week's net − last week's; null until both are known, or when last week is partial */
  delta: number | null;
  rulesVersion: string | null;
}

/**
 * In, Out and Kept for the seven days ending on `asOf` and the seven before, from the engine
 * (`cashflow.period_totals`), live with the database. Stored in computed_results with its
 * rules_version so the recap can be reproduced.
 */
export function useWeekTotals(asOf: string): WeekView {
  const { db } = useDb();
  const lookups = useLookups();
  const coverage = useCoverageStart();
  const [range, setRange] = useState<{
    start: string;
    prevStart: string;
    prevEnd: string;
  } | null>(null);
  const [totals, setTotals] = useState<MonthTotals | null>(null);
  const [previous, setPrevious] = useState<MonthTotals | null>(null);
  const [delta, setDelta] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const start = await addDays(asOf, -6);
      const prevEnd = await addDays(asOf, -7);
      const prevStart = await addDays(asOf, -13);
      if (!alive) return;
      setRange({ start, prevStart, prevEnd });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf]);

  const entries = useLiveQuery(
    () => (range ? entriesBetween(db, range.start, asOf) : Promise.resolve(undefined)),
    [db, range, asOf],
  );
  const prevEntries = useLiveQuery(
    () => (range ? entriesBetween(db, range.prevStart, range.prevEnd) : Promise.resolve(undefined)),
    [db, range],
  );

  useEffect(() => {
    if (!range || !entries || !prevEntries || !lookups || coverage === undefined) return;
    let alive = true;
    void (async () => {
      const current = await periodTotals(
        range.start,
        asOf,
        counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
      );
      const prior = await periodTotals(
        range.prevStart,
        range.prevEnd,
        counted(prevEntries).map((e) => toRuleEntry(e, lookups.categories)),
      );
      // The week before is compared only when the data covers all seven days (invariant 51).
      const change = covers(coverage, range.prevStart)
        ? await netChange(current.net_cents, prior.net_cents)
        : null;
      if (!alive) return;
      setTotals(current);
      setPrevious(prior);
      setDelta(change);
      await db.computed_results.put({
        id: `week_totals:${asOf}`,
        kind: "week_totals",
        as_of: asOf,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: current,
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, range, asOf, entries, prevEntries, lookups, coverage]);

  return {
    start: range?.start ?? null,
    end: asOf,
    entries,
    totals,
    previous,
    delta,
    rulesVersion: engine.rulesVersion,
  };
}
