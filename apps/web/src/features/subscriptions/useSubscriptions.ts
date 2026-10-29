import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { bankText, ignoreClosed, type RecurringSeries, type StackdDb } from "../../data/db.ts";
import {
  daysUntil,
  engine,
  merchantKey,
  type SubscriptionCheck,
  type SubscriptionCheckInput,
  subscriptionCheck,
  type YearlyCost,
  yearlyCost,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { checkThresholds, KIND_TABLE, OTHER_KIND, useCheckIntervals } from "./kinds.ts";
import { isKnownKind, useOwnKinds } from "./ownKinds.ts";

/** The built-in Subscriptions category (data/defaults.ts); renaming it keeps the id. */
export const SUBSCRIPTIONS_CATEGORY = "cat-subscriptions";

export interface SubscriptionsView {
  /** Confirmed bills counted as subscriptions, in the engine's order (highest yearly first). */
  subscriptions: Array<{
    series: RecurringSeries;
    yearly_cents: number;
    monthly_cents: number;
    days: number;
    /** Its kind: the person's own, else the name's, else null (from the subscription check). */
    kind: string | null;
  }>;
  /** Other confirmed bills, which the person can count as a subscription. */
  others: RecurringSeries[];
  totals: YearlyCost;
  /** The subscription check: when to ask "still using it?" and the facts from the charges. */
  check: SubscriptionCheck;
  /** The person's own kinds, id → name, for every label of a kind. */
  labels: ReadonlyMap<string, string>;
}

/**
 * The merchant key each text has (`fingerprint.merchant_key`: NETFLIX, netflix and Netflix.com
 * are one; owner, October 29, 2026), kept for the session: the rule is pure, so a text always
 * keys the same way, and Home, the month review and Subscriptions each read every charge out.
 * Only texts not seen yet go to the engine, together.
 */
const KEYS = new Map<string, string>();

async function payeesOf(texts: Iterable<string>): Promise<Map<string, string>> {
  const missing = [...new Set(texts)].filter((t) => !KEYS.has(t));
  const done = await Promise.all(missing.map(async (t) => [t, await merchantKey(t)] as const));
  for (const [t, payee] of done) KEYS.set(t, payee);
  return KEYS;
}

/**
 * Which confirmed bills are subscriptions: the person's own call when they made one, else
 * whether the payee's latest recurring entry sits in the Subscriptions category.
 */
async function splitBills(db: StackdDb, bills: RecurringSeries[]) {
  const latest = new Map<string, { date: string; category: string | null }>();
  // Every counted charge out by payee, recurring or not: a price rise or the end of a trial is
  // often the charge the ±10% run left out. Only the bills' own payees are kept.
  const charges = new Map<string, Array<{ date: string; cents: number }>>();
  const keyOf = (s: RecurringSeries) => KEYS.get(s.payee) as string;
  if (bills.length === 0) return { subs: [], others: [], charges, keyOf };
  await payeesOf(bills.map((s) => s.payee));
  const wanted = new Set(bills.map(keyOf));
  const out = await db.entries.filter((e) => e.direction === "out").toArray();
  // The bank's text, never the person's rename (invariant 47).
  const cleaned = await payeesOf(out.map(bankText));
  for (const e of out) {
    const payee = cleaned.get(bankText(e)) as string;
    if (!wanted.has(payee)) continue;
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
    const counted = s.subscription ?? latest.get(keyOf(s))?.category === SUBSCRIPTIONS_CATEGORY;
    (counted ? subs : others).push(s);
  }
  return { subs, others, charges, keyOf };
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
  const intervals = useCheckIntervals();
  const own = useOwnKinds();
  const [view, setView] = useState<SubscriptionsView | undefined>(undefined);
  useEffect(() => {
    if (!bills || !intervals || !own) return;
    let alive = true;
    void (async () => {
      const { subs, others, charges, keyOf } = await splitBills(db, bills);
      const totals = await yearlyCost(
        subs.map((s) => ({
          id: s.id,
          label: s.label,
          interval: s.interval,
          expected_cents: s.expected_cents,
        })),
      );
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
            charges: charges.get(keyOf(s)) ?? [],
            // A kind removed on another device before this row synced reads from the name.
            own_kind:
              s.subscription_kind && isKnownKind(s.subscription_kind, own.labels)
                ? s.subscription_kind
                : null,
          }),
        ),
        KIND_TABLE,
        checkThresholds(intervals),
        own.words
          .filter((w) => w.kind !== OTHER_KIND && isKnownKind(w.kind, own.labels))
          .map((w) => ({ match: w.match, kind: w.kind })),
        own.kinds.map((k) => k.id),
      );
      const byId = new Map(subs.map((s) => [s.id, s]));
      const kindOf = new Map(check.items.map((i) => [i.id, i.kind] as const));
      const subscriptions = [];
      for (const item of totals.items) {
        const series = byId.get(item.id) as RecurringSeries;
        subscriptions.push({
          series,
          yearly_cents: item.yearly_cents,
          monthly_cents: item.monthly_cents,
          days: await daysUntil(today, series.next_date),
          kind: kindOf.get(item.id) ?? null,
        });
      }
      await db.computed_results.put({
        id: `subscription_check:${today}`,
        kind: "subscription_check",
        as_of: today,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: check,
        computed_at: new Date().toISOString(),
      });
      if (alive) setView({ subscriptions, others, totals, check, labels: own.labels });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, bills, today, intervals, own]);
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
