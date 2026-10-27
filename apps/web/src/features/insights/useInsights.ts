import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { counted, entriesBetween, ignoreClosed } from "../../data/db.ts";
import {
  addMonths,
  engine,
  type LumpyBills,
  lumpyBills,
  monthBounds,
  type SeasonalFlag,
  seasonalSpikes,
  type UsualFlag,
  vsUsual,
} from "../../engine/bridge.ts";
import { useLookups } from "../entries/useEntries.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";
import { THRESHOLDS } from "./thresholds.ts";

/** Categories running above the same days of the last 3 months (fast-follow 8). */
export function useMoreThanUsual(asOf: string): {
  months_used: number;
  flagged: UsualFlag[];
} | null {
  const { db } = useDb();
  const lookups = useLookups();
  const [start, setStart] = useState<string | null>(null);
  const [result, setResult] = useState<{ months_used: number; flagged: UsualFlag[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const bounds = await monthBounds(asOf);
      const first = await addMonths(bounds.start, -3);
      if (alive) setStart(first);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf]);
  const entries = useLiveQuery(
    () => (start ? entriesBetween(db, start, asOf) : Promise.resolve(undefined)),
    [db, start, asOf],
  );
  useEffect(() => {
    if (!entries || !lookups) return;
    let alive = true;
    void (async () => {
      const out = await vsUsual(
        asOf,
        counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
        THRESHOLDS,
        3,
      );
      if (!alive) return;
      setResult(out);
      await db.computed_results.put({
        id: `vs_usual:${asOf}`,
        kind: "vs_usual",
        as_of: asOf,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: out,
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, entries, lookups, asOf]);
  return result;
}

/** Quarterly / yearly bills ahead and last year's high months coming up (fast-follow 8). */
export function useBiggerMonths(asOf: string): {
  lumpy: LumpyBills | null;
  seasonal: { months_of_history: number; flagged: SeasonalFlag[] } | null;
} {
  const { db } = useDb();
  const lookups = useLookups();
  const series = useLiveQuery(
    () => db.recurring_series.where("status").equals("confirmed").toArray(),
    [db],
  );
  const [start, setStart] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const bounds = await monthBounds(asOf);
      const first = await addMonths(bounds.start, -13);
      if (alive) setStart(first);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [asOf]);
  const entries = useLiveQuery(
    () => (start ? entriesBetween(db, start, asOf) : Promise.resolve(undefined)),
    [db, start, asOf],
  );
  const [lumpy, setLumpy] = useState<LumpyBills | null>(null);
  const [seasonal, setSeasonal] = useState<{
    months_of_history: number;
    flagged: SeasonalFlag[];
  } | null>(null);
  useEffect(() => {
    if (!series) return;
    let alive = true;
    void (async () => {
      const out = await lumpyBills(
        asOf,
        series.map((s) => ({
          payee: s.label,
          kind: s.kind,
          expected_cents: s.expected_cents,
          interval: s.interval,
          next_date: s.next_date,
        })),
        THRESHOLDS,
        12,
      );
      if (alive) setLumpy(out);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [series, asOf]);
  useEffect(() => {
    if (!entries || !lookups) return;
    let alive = true;
    void (async () => {
      const out = await seasonalSpikes(
        asOf,
        counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
        THRESHOLDS,
      );
      if (alive) setSeasonal(out);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [entries, lookups, asOf]);
  return { lumpy, seasonal };
}
