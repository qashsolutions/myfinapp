import { useEffect, useState } from "react";
import { ignoreClosed } from "../../data/db.ts";
import { EngineError, type SafeToSpend, safeToSpend } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import type { ForecastView } from "../forecast/useForecast.ts";

/**
 * Safe to spend (fast-follow 8; the window since October 29, 2026, invariant 53): the forecast's
 * lowest balance from today through the day before the payday after next (the next whole pay
 * period), minus the cushion; with one payday known, through the day before it; with none, the
 * forecast's days. The forecast already subtracts usual daily spending, so this is room beyond
 * that. No forecast or no balance → null, and so is a day the forecast doesn't cover (it was
 * made for another day and is being redone): never yesterday's forecast read as today's, and a
 * rule that refuses shows nothing rather than escaping (November 10, 2026).
 */
export function useSafeToSpend(view: ForecastView, asOf: string): SafeToSpend | null {
  const [result, setResult] = useState<SafeToSpend | null>(null);
  const projection = view.projection;
  const items = view.upcoming?.items;
  const buffer = view.bufferCents;
  useEffect(() => {
    const first = projection?.days[0]?.date;
    const last = projection?.days[projection.days.length - 1]?.date;
    if (
      !projection ||
      view.needsBalance ||
      !first ||
      !last ||
      compareText(asOf, first) < 0 ||
      compareText(asOf, last) > 0
    ) {
      setResult(null);
      return;
    }
    let alive = true;
    void (async () => {
      // Expected paydays ahead: the rule keeps those after today, once each, earliest first.
      const paydays = (items ?? [])
        .filter((i) => i.kind === "income" && !i.matched)
        .map((i) => i.date);
      const out = await safeToSpend(projection.days, buffer, asOf, last, paydays);
      if (alive) setResult(out);
    })().catch((err) => {
      if (alive) setResult(null);
      if (!(err instanceof EngineError)) ignoreClosed(err);
    });
    return () => {
      alive = false;
    };
  }, [projection, items, buffer, asOf, view.needsBalance]);
  return result;
}
