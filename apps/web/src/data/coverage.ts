import { useLiveQuery } from "dexie-react-hooks";
import { addMonths, monthBounds } from "../engine/bridge.ts";
import { compareText } from "../lib/order.ts";
import { useDb } from "./DbProvider.tsx";
import type { StackdDb } from "./db.ts";

/**
 * The first day the person's data covers (invariant 51, October 29, 2026; docs/spec.md "History
 * that counts"): the earliest of every statement import's period start and the first entry's
 * date, over all accounts together. Null when there is nothing yet.
 *
 * A month counts as history (the month before to compare with, an average, "usual") only when
 * this is on or before its 1st; a week only when this is on or before its first day. Statements
 * rarely start on the 1st: two days of September are September's own numbers, never September.
 * Over all accounts, so a card added later never makes the months before it partial.
 */
export async function coverageStart(db: StackdDb): Promise<string | null> {
  const [first, imports] = await Promise.all([
    db.entries.orderBy("date").first(),
    db.statement_imports.toArray(),
  ]);
  let start: string | null = first?.date ?? null;
  for (const i of imports) {
    if (i.period_start && (start === null || compareText(i.period_start, start) < 0))
      start = i.period_start;
  }
  return start;
}

/** coverageStart, live with the database; undefined while reading. */
export function useCoverageStart(): string | null | undefined {
  const { db } = useDb();
  return useLiveQuery(() => coverageStart(db), [db]);
}

/** Whether the data covers the whole period starting on `start` (a month's 1st, a week's day). */
export function covers(from: string | null | undefined, start: string): boolean {
  return typeof from === "string" && compareText(from, start) <= 0;
}

/** The 1st of the first month the data covers whole: `from` itself on a 1st, else next month's. */
export async function firstWholeMonth(from: string | null): Promise<string | null> {
  if (from === null) return null;
  const month = await monthBounds(from);
  return month.start === from ? from : (await monthBounds(await addMonths(month.start, 1))).start;
}
