import { useEffect } from "react";
import { useLookups } from "../features/entries/useEntries.ts";
import { useMoreThanUsual } from "../features/insights/useInsights.ts";
import { todayIso } from "../lib/format.ts";
import { emitMoment } from "./bus.ts";

/**
 * Emits `spending_up` for the category running furthest above its usual pace. The catalog's
 * `once: per_month` keeps it to one kind word per category per month, however often the
 * numbers change; the facts stay on Money in & out's "Running higher than usual" card.
 */
export function SpendingWatch() {
  const result = useMoreThanUsual(todayIso());
  const lookups = useLookups();
  const categoryId = result?.flagged[0]?.category_id;
  const name = categoryId ? lookups?.categories.get(categoryId)?.name : undefined;
  useEffect(() => {
    if (categoryId && name) emitMoment("spending_up", { category: name }, categoryId);
  }, [categoryId, name]);
  return null;
}
