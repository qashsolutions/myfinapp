import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { counted, type Entry, entriesBetween, ignoreClosed } from "../../data/db.ts";
import { cleanDescription, engine, type TopSpending, topSpending } from "../../engine/bridge.ts";
import { type Range, type RangeBounds, rangeBounds } from "../ranges/ranges.ts";

export interface TopSpendingView {
  bounds: RangeBounds | null;
  result: TopSpending | null;
  /** The range's entries by id, so a row can show its category and open it. */
  entries: Map<string, Entry>;
  /** Each money-out entry's payee key as the rule groups it, so a merchant can list its entries. */
  keys: Map<string, string>;
}

/** The biggest amounts out and the merchants paid most often over a time range. */
export function useTopSpending(range: Range, today: string, limit = 10, back = 0): TopSpendingView {
  const { db } = useDb();
  const first = useLiveQuery(
    async () => (await db.entries.orderBy("date").first())?.date ?? null,
    [db],
  );
  const [bounds, setBounds] = useState<RangeBounds | null>(null);
  const [result, setResult] = useState<TopSpending | null>(null);
  const [keys, setKeys] = useState<Map<string, string>>(new Map());
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
  const rows = useLiveQuery(
    () => (bounds ? entriesBetween(db, bounds.start, bounds.end) : Promise.resolve(undefined)),
    [db, bounds],
  );
  useEffect(() => {
    if (!bounds || !rows) return;
    let alive = true;
    void (async () => {
      const top = await topSpending(
        bounds.start,
        bounds.end,
        counted(rows).map((e) => ({
          id: e.id,
          date: e.date,
          amount_cents: e.amount_cents,
          direction: e.direction,
          is_transfer: e.is_transfer,
          payee: e.merchant.trim() ? e.merchant : null,
        })),
        limit,
      );
      const outs = counted(rows).filter(
        (e) => e.direction === "out" && !e.is_transfer && e.merchant.trim(),
      );
      const keyed = await Promise.all(
        outs.map(async (e) => [e.id, await cleanDescription(e.merchant)] as const),
      );
      if (!alive) return;
      setResult(top);
      setKeys(new Map(keyed));
      await db.computed_results.put({
        id: `top_spending:${range}:${bounds.end}`,
        kind: "top_spending",
        as_of: bounds.end,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: top,
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, range, bounds, rows, limit]);
  return {
    bounds,
    result: bounds && result ? result : null,
    entries: new Map((rows ?? []).map((e) => [e.id, e])),
    keys,
  };
}
