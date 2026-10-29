import { useEffect, useState } from "react";
import { ignoreClosed } from "../../data/db.ts";
import { type SafeToSpend, safeToSpend } from "../../engine/bridge.ts";
import type { ForecastView } from "../forecast/useForecast.ts";

/**
 * Safe to spend (fast-follow 8; the window since October 29, 2026, invariant 53): the forecast's
 * lowest balance from today through the day before the payday after next (the next whole pay
 * period), minus the cushion; with one payday known, through the day before it; with none, the
 * forecast's days. The forecast already subtracts usual daily spending, so this is room beyond
 * that. No forecast or no balance → null.
 */
export function useSafeToSpend(view: ForecastView, asOf: string): SafeToSpend | null {
  const [result, setResult] = useState<SafeToSpend | null>(null);
  const projection = view.projection;
  const items = view.upcoming?.items;
  const buffer = view.bufferCents;
  useEffect(() => {
    if (!projection || view.needsBalance) {
      setResult(null);
      return;
    }
    let alive = true;
    void (async () => {
      // Expected paydays ahead: the rule keeps those after today, once each, earliest first.
      const paydays = (items ?? [])
        .filter((i) => i.kind === "income" && !i.matched)
        .map((i) => i.date);
      const until = projection.days[projection.days.length - 1]?.date ?? asOf;
      const out = await safeToSpend(projection.days, buffer, asOf, until, paydays);
      if (alive) setResult(out);
    })().catch((err) => {
      ignoreClosed(err);
      if (alive) setResult(null);
    });
    return () => {
      alive = false;
    };
  }, [projection, items, buffer, asOf, view.needsBalance]);
  return result;
}
