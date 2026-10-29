/**
 * A budget alert in the moment (docs/spec.md "Budgeting"): which budget lines have reached a
 * level of their plan this month, from the `budget.pace` rule. One reading for the Budget
 * screen's "Close" / "Over" words and for the alert schedule: the same lines (`paceLines`) at
 * the same levels (`alertLevels` of the person's "Tell me at"), so both agree.
 *
 * Zero-based budgets are read per category line with something planned. The bucket method
 * (50/30/20 or the person's own split) plans no categories, so it is read per bucket. The save
 * bucket and its categories are never read: putting more aside is not overspending.
 */

import insightsConfig from "@stackd/rules/insights";
import { useEffect, useState } from "react";
import type { BudgetPaceLine, BudgetSummary } from "../../engine/bridge.ts";
import { budgetPace } from "../../engine/bridge.ts";

/** The levels from versioned config (config/insights.yaml `budget_alerts`), never a literal. */
export const BUDGET_LEVELS: number[] = (
  insightsConfig as unknown as { budget_alerts: { levels_bps: number[] } }
).budget_alerts.levels_bps;
/** The first level is "Close". */
export const CLOSE_BPS: number = BUDGET_LEVELS[0] ?? 9000;
const PLAN_BPS = 10000;

/** The id a bucket line goes by (never a category id, so the two can't collide). */
export function bucketLineId(bucket: string): string {
  return `bucket:${bucket}`;
}

export function paceLines(summary: BudgetSummary): BudgetPaceLine[] {
  if (summary.method === "zero_based") {
    return summary.categories
      .filter((c) => c.planned_cents !== null && c.planned_cents > 0 && c.bucket !== "save")
      .map((c) => ({
        category_id: c.category_id,
        planned_cents: c.planned_cents ?? 0,
        spent_cents: c.spent_cents,
      }));
  }
  return summary.buckets
    .filter((b) => b.bucket !== "save" && b.planned_cents > 0)
    .map((b) => ({
      category_id: bucketLineId(b.bucket),
      planned_cents: b.planned_cents,
      spent_cents: b.spent_cents,
    }));
}

/**
 * The levels an alert fires at: the person's "Tell me at" percent (and 100% too when that is
 * lower), else the config's levels.
 */
export function alertLevels(thresholdPct: number | null | undefined): number[] {
  if (!thresholdPct) return BUDGET_LEVELS;
  const own = thresholdPct * 100;
  return own < PLAN_BPS ? [own, PLAN_BPS] : [own];
}

export type PaceWord = "Close" | "Over";

/**
 * Each line's word: "Over" once spent passes the plan, "Close" from the first level, at the
 * person's own "Tell me at" (`thresholdPct`, the budget alert's setting) when they set one.
 */
export function useBudgetPace(
  summary: BudgetSummary | null,
  asOf: string,
  thresholdPct: number | null = null,
): Map<string, PaceWord> | null {
  const [words, setWords] = useState<Map<string, PaceWord> | null>(null);
  useEffect(() => {
    if (!summary) {
      setWords(null);
      return;
    }
    let alive = true;
    const lines = paceLines(summary);
    void budgetPace(summary.start.slice(0, 7), asOf, lines, alertLevels(thresholdPct))
      .then((pace) => {
        if (!alive) return;
        const planned = new Map(lines.map((l) => [l.category_id, l] as const));
        const out = new Map<string, PaceWord>();
        for (const item of pace.items) {
          const line = planned.get(item.category_id);
          const over = line !== undefined && line.spent_cents > line.planned_cents;
          out.set(item.category_id, over ? "Over" : "Close");
        }
        setWords(out);
      })
      .catch(() => {
        if (alive) setWords(new Map());
      });
    return () => {
      alive = false;
    };
  }, [summary, asOf, thresholdPct]);
  return words;
}
