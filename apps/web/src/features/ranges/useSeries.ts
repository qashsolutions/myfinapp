import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { counted, entriesBetween, ignoreClosed } from "../../data/db.ts";
import {
  cashSeries,
  engine,
  type MonthTotals,
  netChange,
  periodTotals,
  type Series,
  type SeriesStepKind,
} from "../../engine/bridge.ts";
import { useLookups } from "../entries/useEntries.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";
import { type Range, type RangeBounds, rangeBounds } from "./ranges.ts";

/** cashflow.series over two dates, live with the database. */
export function useSeries(
  start: string | null,
  end: string | null,
  step: SeriesStepKind,
): Series | null {
  const { db } = useDb();
  const lookups = useLookups();
  const [series, setSeries] = useState<Series | null>(null);
  const entries = useLiveQuery(
    () =>
      start && end && start <= end ? entriesBetween(db, start, end) : Promise.resolve(undefined),
    [db, start, end],
  );
  useEffect(() => {
    if (start && end && start > end) {
      setSeries(null); // nothing to count, and never the previous range's bars
      return;
    }
    if (!start || !end || !entries || !lookups) return;
    let alive = true;
    void cashSeries(
      start,
      end,
      step,
      counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
    )
      .then((s) => {
        if (alive) setSeries(s);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [start, end, step, entries, lookups]);
  return series;
}

export interface RangeView {
  bounds: RangeBounds | null;
  series: Series | null;
  previous: MonthTotals | null;
  /** Kept − the period before's Kept; null for All, or when history doesn't cover the period before. */
  delta: number | null;
  /** The person's first entry of all, for "You have N months so far". */
  firstDate: string | null;
}

/** A range's totals by step plus the same range a period earlier (docs/spec.md "Time ranges"). */
export function useRangeTotals(range: Range, today: string, back = 0): RangeView {
  const { db } = useDb();
  const lookups = useLookups();
  const first = useLiveQuery(
    async () => (await db.entries.orderBy("date").first())?.date ?? null,
    [db],
  );
  const [bounds, setBounds] = useState<RangeBounds | null>(null);
  const [previous, setPrevious] = useState<MonthTotals | null>(null);
  const [delta, setDelta] = useState<number | null>(null);
  useEffect(() => {
    if (first === undefined) return;
    let alive = true;
    void rangeBounds(range, today, first, back)
      .then((b) => {
        if (alive) setBounds(b);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [range, today, first, back]);
  const series = useSeries(bounds?.start ?? null, bounds?.end ?? null, bounds?.step ?? "month");
  const prevEntries = useLiveQuery(
    () =>
      bounds?.previous
        ? entriesBetween(db, bounds.previous.start, bounds.previous.end)
        : Promise.resolve(null),
    [db, bounds],
  );
  useEffect(() => {
    if (!bounds || !series || prevEntries === undefined || !lookups) return;
    let alive = true;
    void (async () => {
      if (!bounds.previous || !prevEntries) {
        if (alive) {
          setPrevious(null);
          setDelta(null);
        }
        return;
      }
      const prior = await periodTotals(
        bounds.previous.start,
        bounds.previous.end,
        counted(prevEntries).map((e) => toRuleEntry(e, lookups.categories)),
      );
      // Compared only when the history covers the whole period before, never a part of it.
      const covered = first !== null && first !== undefined && first <= bounds.previous.start;
      const change =
        covered && prior.count > 0 ? await netChange(series.net_cents, prior.net_cents) : null;
      if (!alive) return;
      setPrevious(prior);
      setDelta(change);
      await db.computed_results.put({
        id: `range_totals:${range}:${series.end}`,
        kind: "range_totals",
        as_of: series.end,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: { series, previous: prior },
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, range, bounds, series, prevEntries, lookups, first]);
  // A series for an older range can still be on screen while the new one loads.
  const current = series && bounds && series.start === bounds.start ? series : null;
  return {
    bounds,
    series: current,
    previous: current ? previous : null,
    delta: current ? delta : null,
    firstDate: first ?? null,
  };
}
