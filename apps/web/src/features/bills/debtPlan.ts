import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Debt, ignoreClosed, type StackdDb } from "../../data/db.ts";
import {
  type DebtInput,
  type PayoffOrder,
  type PayoffPlan,
  payoffPlan,
} from "../../engine/bridge.ts";

/** The extra each month on top of the minimums (fast-follow 1). */
export const EXTRA_SETTING = "debt.extra_cents";
/** Which debt gets the extra first (October 28, 2026); synced like other settings. */
export const ORDER_SETTING = "debt.order";

/** The two fixed ways to order debts, each with its one plain line (a kind, so fixed chips). */
export const PAYOFF_ORDERS: ReadonlyArray<{ value: PayoffOrder; label: string; line: string }> = [
  { value: "avalanche", label: "Highest rate first", line: "Saves the most interest." },
  { value: "snowball", label: "Smallest balance first", line: "Clears a debt sooner." },
];

export function orderLabel(order: PayoffOrder): string {
  return PAYOFF_ORDERS.find((o) => o.value === order)?.label ?? "";
}

export function debtInputs(debts: Debt[]): DebtInput[] {
  return debts.map((d) => ({
    id: d.id,
    label: d.label,
    balance_cents: d.balance_cents,
    apr_bps: d.apr_bps,
    min_payment_cents: d.min_payment_cents,
  }));
}

function readOrder(value: unknown): PayoffOrder {
  return value === "snowball" ? "snowball" : "avalanche";
}

export interface DebtSettings {
  debts: Debt[];
  extra: number;
  order: PayoffOrder;
}

/** The debts with the person's extra and order (live). */
export function useDebtSettings(): DebtSettings | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [debts, extra, order] = await Promise.all([
      db.debts.toArray(),
      db.settings.get(EXTRA_SETTING),
      db.settings.get(ORDER_SETTING),
    ]);
    return {
      debts,
      extra: (extra?.value as number | undefined) ?? 0,
      order: readOrder(order?.value),
    };
  }, [db]);
}

export async function saveSetting(db: StackdDb, key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value, updated_at: new Date().toISOString() });
}

/** The plan at the person's extra and order, straight from `bills.payoff_plan`; null with no
 * debts, undefined while loading. Home's Debt-free card and Bills share it. */
export function useDebtFreePlan(asOf: string): PayoffPlan | null | undefined {
  const settings = useDebtSettings();
  const [plan, setPlan] = useState<PayoffPlan | null | undefined>(undefined);
  useEffect(() => {
    if (!settings) return;
    if (settings.debts.length === 0) {
      setPlan(null);
      return;
    }
    let alive = true;
    void payoffPlan(debtInputs(settings.debts), settings.extra, asOf, settings.order)
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [settings, asOf]);
  return plan;
}
