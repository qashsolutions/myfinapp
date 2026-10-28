import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed, type RecurringSeries, type StackdDb } from "../../data/db.ts";
import {
  cleanDescription,
  daysUntil,
  engine,
  type YearlyCost,
  yearlyCost,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";

/** The built-in Subscriptions category (data/defaults.ts); renaming it keeps the id. */
export const SUBSCRIPTIONS_CATEGORY = "cat-subscriptions";

export interface SubscriptionsView {
  /** Confirmed bills counted as subscriptions, in the engine's order (highest yearly first). */
  subscriptions: Array<{
    series: RecurringSeries;
    yearly_cents: number;
    monthly_cents: number;
    days: number;
  }>;
  /** Other confirmed bills, which the person can count as a subscription. */
  others: RecurringSeries[];
  totals: YearlyCost;
}

/**
 * Which confirmed bills are subscriptions: the person's own call when they made one, else
 * whether the payee's latest recurring entry sits in the Subscriptions category.
 */
async function splitBills(db: StackdDb, bills: RecurringSeries[]) {
  const latest = new Map<string, { date: string; category: string | null }>();
  const flagged = await db.entries.filter((e) => e.is_recurring && e.direction === "out").toArray();
  for (const e of flagged) {
    const payee = await cleanDescription(e.merchant || e.clean_description);
    const seen = latest.get(payee);
    if (!seen || compareText(e.date, seen.date) > 0)
      latest.set(payee, { date: e.date, category: e.category_id });
  }
  const subs: RecurringSeries[] = [];
  const others: RecurringSeries[] = [];
  for (const s of bills) {
    const counted = s.subscription ?? latest.get(s.payee)?.category === SUBSCRIPTIONS_CATEGORY;
    (counted ? subs : others).push(s);
  }
  return { subs, others };
}

/** The Subscriptions view (owner, October 27, 2026): yearly cost from `recurring.yearly_cost`. */
export function useSubscriptions(today: string): SubscriptionsView | undefined {
  const { db } = useDb();
  const bills = useLiveQuery(
    () =>
      db.recurring_series
        .where("status")
        .equals("confirmed")
        .filter((s) => s.kind === "bill")
        .toArray(),
    [db],
  );
  const [view, setView] = useState<SubscriptionsView | undefined>(undefined);
  useEffect(() => {
    if (!bills) return;
    let alive = true;
    void (async () => {
      const { subs, others } = await splitBills(db, bills);
      const totals = await yearlyCost(
        subs.map((s) => ({
          id: s.id,
          label: s.label,
          interval: s.interval,
          expected_cents: s.expected_cents,
        })),
      );
      const byId = new Map(subs.map((s) => [s.id, s]));
      const subscriptions = [];
      for (const item of totals.items) {
        const series = byId.get(item.id) as RecurringSeries;
        subscriptions.push({
          series,
          yearly_cents: item.yearly_cents,
          monthly_cents: item.monthly_cents,
          days: await daysUntil(today, series.next_date),
        });
      }
      await db.computed_results.put({
        id: `subscriptions:${today}`,
        kind: "subscriptions",
        as_of: today,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: totals,
        computed_at: new Date().toISOString(),
      });
      if (alive) setView({ subscriptions, others, totals });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, bills, today]);
  return view;
}

/** The person's own call: count this bill as a subscription, or not. */
export async function setSubscription(db: StackdDb, id: string, value: boolean): Promise<void> {
  await db.recurring_series.update(id, {
    subscription: value,
    updated_at: new Date().toISOString(),
  });
}
