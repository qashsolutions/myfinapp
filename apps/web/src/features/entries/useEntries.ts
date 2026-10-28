import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, type Category, type Entry, entriesBetween } from "../../data/db.ts";
import { monthBounds } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";

/** The month that contains `asOf`, from the engine (dates.month_bounds). */
export function useMonth(asOf: string): { start: string; end: string } | null {
  const [bounds, setBounds] = useState<{ start: string; end: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void monthBounds(asOf).then((b) => {
      if (alive) setBounds(b);
    });
    return () => {
      alive = false;
    };
  }, [asOf]);
  return bounds;
}

/** Live: re-renders whenever entries in the range change. */
export function useEntriesBetween(start: string | null, end: string | null): Entry[] | undefined {
  const { db } = useDb();
  return useLiveQuery(
    () => (start && end ? entriesBetween(db, start, end) : Promise.resolve([] as Entry[])),
    [db, start, end],
  );
}

export function useRecentEntries(limit: number): Entry[] | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const rows = await db.entries
      .orderBy("date")
      .reverse()
      .limit(limit * 3)
      .toArray();
    return rows
      .sort((a, b) =>
        a.date === b.date ? compareText(b.created_at, a.created_at) : compareText(b.date, a.date),
      )
      .slice(0, limit);
  }, [db, limit]);
}

export interface Lookups {
  accounts: Map<string, Account>;
  categories: Map<string, Category>;
}

export function useLookups(): Lookups | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [accounts, categories] = await Promise.all([
      db.accounts.toArray(),
      db.categories.toArray(),
    ]);
    return {
      accounts: new Map(accounts.map((a) => [a.id, a])),
      categories: new Map(categories.map((c) => [c.id, c])),
    };
  }, [db]);
}

export function accountLabel(a: Account | undefined): string {
  if (!a) return "";
  return a.last4 ? `${a.label} ••${a.last4}` : a.label;
}
