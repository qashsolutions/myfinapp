import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { covers, useCoverageStart } from "../../data/coverage.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { counted, type Entry, entriesBetween, ignoreClosed } from "../../data/db.ts";
import {
  addMonths,
  engine,
  type MonthTotals,
  monthBounds,
  monthTotals,
  netChange,
} from "../../engine/bridge.ts";
import { useLookups } from "../entries/useEntries.ts";
import { toRuleEntry } from "./ruleEntries.ts";

export interface MonthView {
  bounds: { start: string; end: string } | null;
  entries: Entry[] | undefined;
  totals: MonthTotals | null;
  previous: MonthTotals | null;
  /** net − previous net; null until both months are known, or when the month before is partial */
  delta: number | null;
  /**
   * The month before is only partly in the data (it starts after its 1st): never compared
   * (invariant 51). False while loading.
   */
  previousPartial: boolean;
  rulesVersion: string | null;
}

/**
 * In, Out and Kept for the month containing `asOf`, from the engine, live with the database.
 * The result is stored in computed_results with its rules_version so it can be reproduced.
 */
export function useMonthTotals(asOf: string): MonthView {
  const { db } = useDb();
  const lookups = useLookups();
  const coverage = useCoverageStart();
  const [bounds, setBounds] = useState<{ start: string; end: string } | null>(null);
  const [prevBounds, setPrevBounds] = useState<{ start: string; end: string } | null>(null);
  const [totals, setTotals] = useState<MonthTotals | null>(null);
  const [previous, setPrevious] = useState<MonthTotals | null>(null);
  const [delta, setDelta] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const b = await monthBounds(asOf);
      const prevStart = await addMonths(b.start, -1);
      const pb = await monthBounds(prevStart);
      if (!alive) return;
      setBounds(b);
      setPrevBounds(pb);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf]);

  const entries = useLiveQuery(
    () => (bounds ? entriesBetween(db, bounds.start, bounds.end) : Promise.resolve(undefined)),
    [db, bounds],
  );
  const prevEntries = useLiveQuery(
    () =>
      prevBounds
        ? entriesBetween(db, prevBounds.start, prevBounds.end)
        : Promise.resolve(undefined),
    [db, prevBounds],
  );

  useEffect(() => {
    if (!bounds || !prevBounds || !entries || !prevEntries || !lookups || coverage === undefined)
      return;
    let alive = true;
    void (async () => {
      const current = await monthTotals(
        bounds.start,
        counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
      );
      const prior = await monthTotals(
        prevBounds.start,
        counted(prevEntries).map((e) => toRuleEntry(e, lookups.categories)),
      );
      // Compared only when the data covers the whole month before (invariant 51).
      const change = covers(coverage, prevBounds.start)
        ? await netChange(current.net_cents, prior.net_cents)
        : null;
      if (!alive) return;
      setTotals(current);
      setPrevious(prior);
      setDelta(change);
      const version = engine.rulesVersion ?? "unknown";
      await db.computed_results.put({
        id: `month_totals:${current.start}`,
        kind: "month_totals",
        as_of: current.start,
        rules_version: version,
        payload: current,
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, bounds, prevBounds, entries, prevEntries, lookups, coverage]);

  const previousPartial =
    coverage !== undefined &&
    prevBounds !== null &&
    previous !== null &&
    previous.count > 0 &&
    !covers(coverage, prevBounds.start);
  return {
    bounds,
    entries,
    totals,
    previous,
    delta,
    previousPartial,
    rulesVersion: engine.rulesVersion,
  };
}
