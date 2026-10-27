import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type Budget,
  type BudgetLine,
  type BudgetMethod,
  counted,
  entriesBetween,
  ignoreClosed,
  newId,
  type StackdDb,
} from "../../data/db.ts";
import {
  type BudgetRuleEntry,
  type BudgetRuleLine,
  type BudgetSummary,
  budgetSummary,
  engine,
  monthBounds,
} from "../../engine/bridge.ts";
import { useLookups } from "../entries/useEntries.ts";

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Create the month's budget, copying lines from `from` when given. */
export async function createBudget(
  db: StackdDb,
  month: string,
  method: BudgetMethod,
  takeHomeCents: number,
  lines: Array<{ category_id: string; planned_cents: number }> = [],
  now: Date = new Date(),
  splitBps: Budget["split_bps"] = null,
): Promise<Budget> {
  const stamp = now.toISOString();
  const budget: Budget = {
    id: newId(),
    month,
    method,
    take_home_cents: takeHomeCents,
    split_bps: splitBps,
    created_at: stamp,
    updated_at: stamp,
  };
  await db.transaction("rw", [db.budgets, db.budget_lines], async () => {
    await db.budgets.add(budget);
    if (lines.length) {
      await db.budget_lines.bulkAdd(
        lines.map((l) => ({
          id: newId(),
          budget_id: budget.id,
          category_id: l.category_id,
          planned_cents: l.planned_cents,
        })),
      );
    }
  });
  return budget;
}

export interface BudgetView {
  budget: Budget | null | undefined; // undefined while loading
  lines: BudgetLine[];
  summary: BudgetSummary | null;
  bounds: { start: string; end: string } | null;
}

/**
 * The budget for the month that contains `asOf`, with planned-vs-spent from the engine.
 * The current month's budget is carried forward from the latest one when missing.
 */
export function useBudget(asOf: string, carryForward: boolean): BudgetView {
  const { db } = useDb();
  const lookups = useLookups();
  const month = monthKey(asOf);
  const [bounds, setBounds] = useState<{ start: string; end: string } | null>(null);
  const [summary, setSummary] = useState<BudgetSummary | null>(null);

  useEffect(() => {
    let alive = true;
    void monthBounds(asOf).then((b) => {
      if (alive) setBounds(b);
    });
    return () => {
      alive = false;
    };
  }, [asOf]);

  const budget = useLiveQuery<Budget | null>(
    async () => (await db.budgets.where("month").equals(month).first()) ?? null,
    [db, month],
  );
  const lines = useLiveQuery<BudgetLine[]>(
    async () => (budget ? db.budget_lines.where("budget_id").equals(budget.id).toArray() : []),
    [db, budget?.id],
  );
  const entries = useLiveQuery(
    () => (bounds ? entriesBetween(db, bounds.start, bounds.end) : Promise.resolve(undefined)),
    [db, bounds],
  );

  // carry the latest budget forward into this month
  useEffect(() => {
    if (!carryForward || budget !== null) return;
    let alive = true;
    void (async () => {
      const latest = (await db.budgets.orderBy("month").reverse().first()) ?? null;
      if (!latest || latest.month >= month || !alive) return;
      const latestLines = await db.budget_lines.where("budget_id").equals(latest.id).toArray();
      if (await db.budgets.where("month").equals(month).first()) return;
      await createBudget(
        db,
        month,
        latest.method,
        latest.take_home_cents,
        latestLines,
        new Date(),
        latest.split_bps ?? null,
      );
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, budget, month, carryForward]);

  useEffect(() => {
    if (!budget || !lines || !entries || !lookups) {
      if (budget === null) setSummary(null);
      return;
    }
    let alive = true;
    const bucketOf = (categoryId: string | null) =>
      categoryId ? (lookups.categories.get(categoryId)?.bucket ?? null) : null;
    const ruleLines: BudgetRuleLine[] = lines.map((l) => ({
      category_id: l.category_id,
      bucket: bucketOf(l.category_id),
      planned_cents: l.planned_cents,
    }));
    const ruleEntries: BudgetRuleEntry[] = counted(entries).map((e) => ({
      date: e.date,
      amount_cents: e.amount_cents,
      direction: e.direction,
      is_transfer: e.is_transfer,
      category_id: e.category_id,
      bucket: bucketOf(e.category_id),
    }));
    void budgetSummary(
      asOf,
      budget.method,
      budget.take_home_cents,
      ruleLines,
      ruleEntries,
      budget.method === "50_30_20" ? (budget.split_bps ?? null) : null,
    ).then(async (s) => {
      if (!alive) return;
      setSummary(s);
      await db.computed_results.put({
        id: `budget_summary:${s.start}`,
        kind: "budget_summary",
        as_of: s.start,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: s,
        computed_at: new Date().toISOString(),
      });
    });
    return () => {
      alive = false;
    };
  }, [db, asOf, budget, lines, entries, lookups]);

  return { budget, lines: lines ?? [], summary, bounds };
}
