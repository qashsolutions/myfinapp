import keywordsConfig from "@stackd/rules/keywords";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed, type RecurringSeries, type StackdDb } from "../../data/db.ts";
import {
  cleanDescription,
  daysUntil,
  engine,
  type SubscriptionCheck,
  type SubscriptionCheckInput,
  subscriptionCheck,
  type YearlyCost,
  yearlyCost,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { THRESHOLDS } from "../insights/thresholds.ts";

/** The hand-edited subscription kinds (config/keywords.yaml `subscription_kinds`). */
const KINDS = (keywordsConfig as { subscription_kinds: Array<{ match: string; kind: string }> })
  .subscription_kinds;

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
  /** The subscription check: when to ask "still using it?" and the facts from the charges. */
  check: SubscriptionCheck;
}

/**
 * Which confirmed bills are subscriptions: the person's own call when they made one, else
 * whether the payee's latest recurring entry sits in the Subscriptions category.
 */
async function splitBills(db: StackdDb, bills: RecurringSeries[]) {
  const latest = new Map<string, { date: string; category: string | null }>();
  // Every counted charge out by payee, recurring or not: a price rise or the end of a trial is
  // often the charge the ±10% run left out. One engine call per distinct text, not per entry.
  const charges = new Map<string, Array<{ date: string; cents: number }>>();
  const cleaned = new Map<string, string>();
  const out = await db.entries.filter((e) => e.direction === "out").toArray();
  for (const e of out) {
    const text = e.merchant || e.clean_description;
    let payee = cleaned.get(text);
    if (payee === undefined) {
      payee = await cleanDescription(text);
      cleaned.set(text, payee);
    }
    if (!e.is_transfer && !e.not_counted) {
      const list = charges.get(payee);
      if (list) list.push({ date: e.date, cents: e.amount_cents });
      else charges.set(payee, [{ date: e.date, cents: e.amount_cents }]);
    }
    if (!e.is_recurring) continue;
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
  return { subs, others, charges };
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
      const { subs, others, charges } = await splitBills(db, bills);
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
      const check = await subscriptionCheck(
        today,
        subs.map(
          (s): SubscriptionCheckInput => ({
            id: s.id,
            label: s.label,
            payee: s.payee,
            interval: s.interval,
            expected_cents: s.expected_cents,
            next_date: s.next_date,
            checked_at: s.checked_at ?? null,
            charges: charges.get(s.payee) ?? [],
          }),
        ),
        KINDS,
        THRESHOLDS,
      );
      await db.computed_results.put({
        id: `subscription_check:${today}`,
        kind: "subscription_check",
        as_of: today,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: check,
        computed_at: new Date().toISOString(),
      });
      if (alive) setView({ subscriptions, others, totals, check });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, bills, today]);
  return view;
}

/** "Keep it" on the subscription check: answered today, asked again in a while. */
export async function keepSubscription(db: StackdDb, id: string, today: string): Promise<void> {
  await db.recurring_series.update(id, {
    checked_at: today,
    updated_at: new Date().toISOString(),
  });
}

/** The person's own call: count this bill as a subscription, or not. */
export async function setSubscription(db: StackdDb, id: string, value: boolean): Promise<void> {
  await db.recurring_series.update(id, {
    subscription: value,
    updated_at: new Date().toISOString(),
  });
}
