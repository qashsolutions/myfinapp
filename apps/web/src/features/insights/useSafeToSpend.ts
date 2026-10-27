import { useEffect, useState } from "react";
import { ignoreClosed } from "../../data/db.ts";
import { addDays, type SafeToSpend, safeToSpend } from "../../engine/bridge.ts";
import type { ForecastView } from "../forecast/useForecast.ts";

/**
 * Safe to spend until payday (fast-follow 8): the forecast's lowest balance between today and
 * the day before the next expected income, minus the buffer. The forecast already subtracts
 * usual daily spending, so this is room beyond that. No forecast or no balance → null.
 */
export function useSafeToSpend(
  view: ForecastView,
  asOf: string,
): (SafeToSpend & { payday: string | null }) | null {
  const [result, setResult] = useState<(SafeToSpend & { payday: string | null }) | null>(null);
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
      const payday =
        (items ?? [])
          .filter((i) => i.kind === "income" && !i.matched && i.date > asOf)
          .map((i) => i.date)
          .sort()[0] ?? null;
      const until = payday
        ? await addDays(payday, -1)
        : (projection.days[projection.days.length - 1]?.date ?? asOf);
      const out = await safeToSpend(projection.days, buffer, asOf, until);
      if (alive) setResult({ ...out, payday });
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
