import nextMoveConfig from "@stackd/rules/next_move";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import type { GroupSummary } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type Goal, ignoreClosed, type PaySettings } from "../../data/db.ts";
import {
  addDays,
  avalancheOrder,
  emergencySummary,
  goalPlan,
  goalProgress,
  monthBounds,
  type NextMove,
  type NextMoveConfig,
  type NextMoveFacts,
  nextMove,
  nextPaydays,
  paydayNudge,
  pctOf,
  periodsUntil,
  ratioBps,
  type SetAside,
  setAside,
} from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { emitMoment } from "../../moments/bus.ts";
import { usePlanDebts } from "../bills/debtPlan.ts";
import { payScheduleOf } from "../budget/payDays.ts";
import { type BudgetView, useBudget } from "../budget/useBudget.ts";
import { type ForecastView, useForecast } from "../forecast/useForecast.ts";
import { addGoalEvent, newMoneyIn, useGoals } from "../goals/useGoals.ts";
import { useGroups } from "../groups/useGroups.ts";
import { type MonthView, useMonthTotals } from "../money/useMonthTotals.ts";

const CONFIG = nextMoveConfig as NextMoveConfig;

export interface HomeView {
  month: MonthView;
  budget: BudgetView;
  forecast: ForecastView;
  /** "under" when Kept >= 0, "over" otherwise; null until something came in. */
  verdict: "under" | "over" | null;
  /** Spent ÷ Got in basis points; null when nothing came in. */
  meterBps: number | null;
  setAside: SetAside | null;
  targetCents: number | null;
  move: NextMove | null;
  jars: Goal[];
  emergencyJar: Goal | null;
  challenge: GroupSummary | null;
  ready: boolean;
}

/** Budget's pay settings as a payday schedule; one reading in `budget/payDays.ts`. */
export { payScheduleOf };

export function isEmergencyJar(goal: Goal): boolean {
  return goal.kind === "save" && goal.title.trim().toLowerCase() === "emergency fund";
}

/**
 * Everything the top of Home needs, from the engine: the month's Got / Spent / Kept with the
 * verdict and spend meter, Set aside against the save target, the paydays, and the next move
 * (shortfall first, then the config's order).
 */
export function useHome(asOf: string): HomeView & { logSetAside: () => Promise<boolean> } {
  const { db } = useDb();
  const month = useMonthTotals(asOf);
  const budget = useBudget(asOf, false);
  const forecast = useForecast(asOf);
  const goals = useGoals();
  const groups = useGroups();
  const pay = useLiveQuery(
    async () => ((await db.settings.get("pay"))?.value as PaySettings | undefined) ?? null,
    [db],
  );
  // The payoff plan's own debts: hand-added ones and linked cards, once each (invariant 65).
  const debts = usePlanDebts()?.debts;
  const fund = useLiveQuery(async () => (await db.emergency_fund.get("me")) ?? null, [db]);
  // Deposits and withdrawals (Move money), so a jar's saved matches its goal screen.
  const jarEvents = useLiveQuery(
    async () =>
      (
        await db.goal_events
          .filter((e) => e.type === "deposit" || e.type === "withdrawal")
          .toArray()
      ).sort((a, b) => compareText(a.date, b.date)),
    [db],
  );
  const [computed, setComputed] = useState<{
    verdict: HomeView["verdict"];
    meterBps: number | null;
    setAside: SetAside | null;
    targetCents: number | null;
    move: NextMove | null;
    ready: boolean;
  }>({
    verdict: null,
    meterBps: null,
    setAside: null,
    targetCents: null,
    move: null,
    ready: false,
  });

  const jars = useMemo(
    () => (goals ?? []).filter((g) => g.kind === "save" && g.status !== "archived"),
    [goals],
  );
  const emergencyJar = useMemo(() => jars.find(isEmergencyJar) ?? null, [jars]);
  const totals = month.totals;
  const budgetSummary = budget.summary;
  const budgetLoaded = budget.budget !== undefined;
  const forecastLoading = forecast.loading;
  const projection = forecast.projection;
  const upcoming = forecast.upcoming;
  const series = forecast.series;

  useEffect(() => {
    if (
      !totals ||
      !budgetLoaded ||
      forecastLoading ||
      pay === undefined ||
      !jarEvents ||
      !goals ||
      !debts ||
      fund === undefined
    )
      return;
    let alive = true;
    void (async () => {
      const share = CONFIG.thresholds.set_aside_share_bps ?? 1000;
      const meterBps =
        totals.in_cents > 0 ? await ratioBps(totals.out_cents, totals.in_cents) : null;
      const verdict: HomeView["verdict"] =
        totals.in_cents > 0 ? (totals.net_cents >= 0 ? "under" : "over") : null;
      // The month's save target: the budget's save bucket, else a share of take-home.
      const saveBucket = budgetSummary?.buckets.find((b) => b.bucket === "save") ?? null;
      const takeHome = budget.budget?.take_home_cents ?? pay?.monthly_cents ?? null;
      const targetCents = saveBucket
        ? saveBucket.planned_cents
        : takeHome && takeHome > 0
          ? await pctOf(takeHome, share)
          : null;
      // Paydays this month, from Budget's pay settings.
      const bounds = await monthBounds(asOf);
      const schedule = payScheduleOf(pay ?? undefined);
      const paydays = schedule
        ? (await nextPaydays(await addDays(bounds.start, -1), schedule, 8)).filter(
            (d) => d <= bounds.end,
          )
        : [];
      const jarIds = new Set(jars.map((g) => g.id));
      const monthDeposits = newMoneyIn(jarEvents)
        .filter((e) => jarIds.has(e.goal_id) && e.amount_cents !== null)
        .map((e) => ({ date: e.date, amount_cents: e.amount_cents as number }));
      const aside = await setAside(monthDeposits, asOf, targetCents, paydays);
      const todayPayday = aside.paydays.find((p) => p.date === asOf) ?? null;
      const paydayFacts =
        todayPayday && pay
          ? {
              paycheck_cents: pay.amount_cents,
              suggested_cents: await paydayNudge(
                pay.amount_cents,
                targetCents,
                takeHome ?? 0,
                share,
              ),
              set_aside_this_period: todayPayday.set_aside,
            }
          : null;
      // The emergency fund is a jar (spec: "jar with runway"); nothing saved when there is none.
      let emergencySaved = 0;
      if (emergencyJar) {
        const events = jarEvents
          .filter((e) => e.goal_id === emergencyJar.id)
          .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents }));
        const p = await goalProgress(
          {
            kind: "save",
            target_cents: emergencyJar.target_cents,
            start_date: emergencyJar.start_date,
            end_date: emergencyJar.end_date,
          },
          events,
          asOf,
        );
        emergencySaved = p.current;
      }
      // The top-priority jar behind its pace (fast-follow 3): expected by now against saved.
      let behindGoal: NextMoveFacts["behind_goal"] = null;
      for (const g of jars) {
        if (g.paused_at || g.is_ongoing || g.grow || !g.cadence || !g.target_cents) continue;
        if (!g.end_date && !g.per_period_cents) continue;
        if (g.cadence === "payday" && !schedule) continue;
        const events = jarEvents
          .filter((e) => e.goal_id === g.id)
          .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents }));
        const planned = await goalPlan(
          {
            kind: "save",
            target_cents: g.target_cents,
            start_date: g.start_date,
            end_date: g.end_date,
            cadence: g.cadence,
            per_period_cents: g.per_period_cents ?? null,
          },
          events,
          asOf,
          schedule,
        );
        if (!planned.per_period_cents || planned.remaining_cents === 0) continue;
        const elapsed = await periodsUntil(g.start_date, asOf, g.cadence, schedule);
        const saved = g.target_cents - planned.remaining_cents;
        const behind = elapsed * planned.per_period_cents - saved;
        if (behind >= planned.per_period_cents) {
          behindGoal = {
            id: g.id,
            title: g.title,
            per_period_cents: planned.per_period_cents,
            behind_cents: behind,
          };
          break; // jars come in priority order
        }
      }
      const nextBill =
        (upcoming?.items ?? []).filter((i) => i.kind === "bill" && !i.matched)[0] ?? null;
      const maxApr = debts.length ? (await avalancheOrder(debts)).max_apr_bps : null;
      const runway =
        emergencyJar && fund?.essentials_cents
          ? (
              await emergencySummary(
                emergencySaved,
                fund.essentials_cents,
                fund.target_months,
                fund.monthly_plan_cents ?? 0,
              )
            ).runway_tenths
          : null;
      const move = await nextMove(
        {
          shortfall: projection?.shortfall
            ? {
                short_by_cents: projection.short_by_cents,
                date: projection.first_short_date ?? asOf,
              }
            : null,
          take_home_cents: takeHome,
          payday: paydayFacts,
          emergency_saved_cents: emergencySaved,
          max_apr_bps: maxApr,
          next_bill: nextBill
            ? {
                label: series.get(nextBill.series_id)?.label ?? nextBill.payee,
                date: nextBill.date,
                amount_cents: nextBill.amount_cents,
              }
            : null,
          runway_tenths: runway,
          behind_goal: behindGoal,
        },
        CONFIG,
        asOf,
      );
      if (alive)
        setComputed({ verdict, meterBps, setAside: aside, targetCents, move, ready: true });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [
    totals,
    budgetLoaded,
    budgetSummary,
    budget.budget,
    forecastLoading,
    projection,
    upcoming,
    series,
    pay,
    jarEvents,
    goals,
    jars,
    emergencyJar,
    debts,
    fund,
    asOf,
  ]);

  /** One tap on payday: record the suggested amount in the emergency jar (or the first jar). */
  async function logSetAside(): Promise<boolean> {
    const amount =
      computed.move?.id === "payday_set_aside" ? Number(computed.move.params.amount_cents) : 0;
    const jar = emergencyJar ?? jars[0] ?? null;
    if (!jar || amount <= 0) return false;
    const ev = await addGoalEvent(db, jar.id, "deposit", asOf, amount);
    emitMoment("jar_deposit", { jar: jar.title, amount: formatCents(amount) }, ev.id);
    return true;
  }

  return {
    month,
    budget,
    forecast,
    ...computed,
    jars,
    emergencyJar,
    challenge: groups.groups?.[0] ?? null,
    logSetAside,
  };
}
