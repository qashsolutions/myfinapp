import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { EmergencyFund, StackdDb } from "../../data/db.ts";
import { type EmergencySummary, emergencySummary } from "../../engine/bridge.ts";
import { todayIso } from "../../lib/format.ts";
import { useBudget } from "../budget/useBudget.ts";

export const DEFAULT_FUND: EmergencyFund = {
  id: "me",
  essentials_cents: null,
  target_months: 3,
  monthly_plan_cents: null,
  updated_at: "",
};

export function useEmergencyFund(): EmergencyFund | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => (await db.emergency_fund.get("me")) ?? DEFAULT_FUND, [db]);
}

export async function saveEmergencyFund(
  db: StackdDb,
  patch: Partial<Omit<EmergencyFund, "id" | "updated_at">>,
): Promise<void> {
  const current = (await db.emergency_fund.get("me")) ?? DEFAULT_FUND;
  await db.emergency_fund.put({
    ...current,
    ...patch,
    id: "me",
    updated_at: new Date().toISOString(),
  });
}

/**
 * Runway, milestones and ETA for the emergency jar. Essentials fall back to Budget's planned
 * needs for the month ("needs from your budget") until the user enters their own number.
 */
export function useEmergencySummary(savedCents: number): {
  fund: EmergencyFund | undefined;
  essentialsCents: number;
  essentialsFromBudget: boolean;
  summary: EmergencySummary | null;
} {
  const fund = useEmergencyFund();
  const budget = useBudget(todayIso(), false);
  const needs = budget.summary?.buckets.find((b) => b.bucket === "need")?.planned_cents ?? 0;
  const essentialsCents = fund?.essentials_cents ?? needs;
  const essentialsFromBudget =
    fund?.essentials_cents === null || fund?.essentials_cents === undefined;
  const [summary, setSummary] = useState<EmergencySummary | null>(null);
  const targetMonths = fund?.target_months ?? 3;
  const plan = fund?.monthly_plan_cents ?? 0;
  useEffect(() => {
    if (!fund) return;
    let alive = true;
    void emergencySummary(savedCents, essentialsCents, targetMonths, plan).then((s) => {
      if (alive) setSummary(s);
    });
    return () => {
      alive = false;
    };
  }, [fund, savedCents, essentialsCents, targetMonths, plan]);
  return { fund, essentialsCents, essentialsFromBudget, summary };
}
