import { useLiveQuery } from "dexie-react-hooks";
import { useDb } from "../../data/DbProvider.tsx";

/** The person's own numbers for Later (October 25, 2026), kept in `settings` `later.plan`. */
export interface LaterPlan {
  age_now: number;
  retire_age: number;
  start_cents: number;
  monthly_cents: number;
  /** Low, middle, high yearly rates in basis points, ascending. */
  rates_bps: [number, number, number];
  /** 0 = no goal. */
  target_cents: number;
}

export const LATER_KEY = "later.plan";

// Starting values until the person changes them. Rates 3% / 5% / 7% (owner sign-off, October 25, 2026).
export const DEFAULT_PLAN: LaterPlan = {
  age_now: 35,
  retire_age: 67,
  start_cents: 0,
  monthly_cents: 20000,
  rates_bps: [300, 500, 700],
  target_cents: 0,
};

export function useLaterPlan(): [LaterPlan | undefined, (plan: LaterPlan) => Promise<void>] {
  const { db } = useDb();
  const plan = useLiveQuery(
    async () =>
      ((await db.settings.get(LATER_KEY))?.value as LaterPlan | undefined) ?? DEFAULT_PLAN,
    [db],
  );
  const save = async (next: LaterPlan) => {
    await db.settings.put({ key: LATER_KEY, value: next, updated_at: new Date().toISOString() });
  };
  return [plan, save];
}
