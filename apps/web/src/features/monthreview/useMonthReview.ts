import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Goal, type GoalEvent, ignoreClosed } from "../../data/db.ts";
import {
  addMonths,
  type CardMonth,
  engine,
  type GrowPace,
  goalProgress,
  growGoalPace,
  growGoalPlan,
  monthBounds,
  oneChange,
  type PayoffPlan,
  whatIfDebt,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { debtInputs, useDebtFreePlan, useDebtSettings } from "../bills/debtPlan.ts";
import { type BudgetView, useBudget } from "../budget/useBudget.ts";
import { type CreditCardView, useCreditCards } from "../credit/useCreditCards.ts";
import { type FixedFlexibleView, useFixedFlexible } from "../fixed/useFixedFlexible.ts";
import { newMoneyIn, useGoals } from "../goals/useGoals.ts";
import { type SubscriptionsView, useSubscriptions } from "../subscriptions/useSubscriptions.ts";
import {
  buildOptions,
  DEBT_ADD_CENTS,
  mostOver,
  ONE_CHANGE_ORDER,
  type PickedChange,
} from "./monthReview.ts";

export interface MonthSpan {
  /** YYYY-MM */
  month: string;
  start: string;
  end: string;
}

/** The whole month `month` (YYYY-MM), or the month just ended when null. */
export function useMonthSpan(month: string | null, today: string): MonthSpan | null {
  const [span, setSpan] = useState<MonthSpan | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const day = month ? `${month}-01` : await addMonths(today, -1);
      const b = await monthBounds(day);
      if (alive) setSpan({ month: b.start.slice(0, 7), start: b.start, end: b.end });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [month, today]);
  return span;
}

export interface JarsMonth {
  /** Jars that existed by the month's end. */
  count: number;
  /** New money in that month (moves between jars left out), per jar, largest first. */
  deposits: Array<{ goal: Goal; cents: number }>;
  totalCents: number;
  /** Jars that reached their target during the month. */
  reached: Goal[];
  /** Grows-over-time jars and their pace at the month's end. */
  grows: Array<{ goal: Goal; pace: GrowPace["status"] }>;
  /** Each jar with a target: how far along it was at the month's end, in bps (capped at 100%). */
  progressBps: Map<string, number>;
}

function asOfEvents(events: GoalEvent[], goalId: string, asOf: string) {
  return events
    .filter((e) => e.goal_id === goalId && compareText(e.date, asOf) <= 0)
    .sort((a, b) => compareText(a.date, b.date) || compareText(a.created_at, b.created_at))
    .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents }));
}

/** Jars for one month: new money in, reached ones and grows-jar pace, all from the engine. */
export function useJarsMonth(span: MonthSpan | null): JarsMonth | undefined {
  const { db } = useDb();
  const goals = useGoals();
  const events = useLiveQuery(() => db.goal_events.toArray(), [db]);
  const [view, setView] = useState<JarsMonth | undefined>(undefined);
  useEffect(() => {
    if (!span || !goals || !events) return;
    let alive = true;
    void (async () => {
      const dayBefore = (await monthBounds(await addMonths(span.start, -1))).end;
      const jars = goals.filter(
        (g) => g.kind === "save" && compareText(g.created_at.slice(0, 10), span.end) <= 0,
      );
      const inMonth = newMoneyIn(events).filter(
        (e) => compareText(e.date, span.start) >= 0 && compareText(e.date, span.end) <= 0,
      );
      const byJar = new Map<string, number>();
      let totalCents = 0;
      for (const e of inMonth) {
        const cents = e.amount_cents ?? 0;
        totalCents += cents;
        byJar.set(e.goal_id, (byJar.get(e.goal_id) ?? 0) + cents);
      }
      const deposits = jars
        .filter((g) => (byJar.get(g.id) ?? 0) > 0)
        .map((goal) => ({ goal, cents: byJar.get(goal.id) ?? 0 }))
        .sort((a, b) => b.cents - a.cents);
      const reached: Goal[] = [];
      const grows: JarsMonth["grows"] = [];
      const progressBps = new Map<string, number>();
      for (const g of jars) {
        if (g.is_ongoing || !(g.target_cents && g.target_cents > 0)) continue;
        const rule = {
          kind: "save",
          target_cents: g.target_cents,
          start_date: g.start_date,
          end_date: g.end_date,
        };
        const atEnd = await goalProgress(rule, asOfEvents(events, g.id, span.end), span.end);
        progressBps.set(g.id, atEnd.display_bps);
        if (atEnd.status === "reached") {
          const before = await goalProgress(rule, asOfEvents(events, g.id, dayBefore), dayBefore);
          if (before.status !== "reached") reached.push(g);
        }
        const grow = g.grow;
        if (grow && g.end_date && compareText(grow.priced_on, span.end) <= 0) {
          try {
            const start = await growGoalPlan({
              today_cost_cents: grow.today_cents,
              cost_rise_bps: grow.cost_rise_bps,
              return_bps: grow.return_bps,
              target_date: g.end_date,
              priced_on: grow.priced_on,
              saved_cents: 0,
              as_of: grow.priced_on,
            });
            const pace = await growGoalPace({
              plan_monthly_cents: start.monthly_needed_cents,
              deposited_cents: atEnd.current,
              start_date: grow.priced_on,
              as_of: span.end,
            });
            grows.push({ goal: g, pace: pace.status });
          } catch {
            // a jar whose plan the rule refuses (its date passed) shows no pace
          }
        }
      }
      if (alive) setView({ count: jars.length, deposits, totalCents, reached, grows, progressBps });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [span, goals, events]);
  return view;
}

export interface MonthReview {
  span: MonthSpan;
  how: FixedFlexibleView | undefined;
  budget: BudgetView;
  jars: JarsMonth | undefined;
  plan: PayoffPlan | null | undefined;
  cards: Array<{ view: CreditCardView; month: CardMonth }>;
  subs: SubscriptionsView | undefined;
  /** The one change (insights.one_change); null when nothing qualifies, undefined while loading. */
  change: PickedChange | null | undefined;
}

/** Everything the month review shows, from the hooks the other screens use. */
export function useMonthReview(span: MonthSpan | null, today: string): MonthReview | null {
  const { db } = useDb();
  // Hooks need a date before the span is known; today's month is harmless until then.
  const start = span?.start ?? today;
  const end = span?.end ?? today;
  // Five whole months before it, so the summary's kept-rate bars show six months.
  const how = useFixedFlexible(start, today, 5);
  const budget = useBudget(end, false);
  const jars = useJarsMonth(span);
  const plan = useDebtFreePlan(today);
  const debtSettings = useDebtSettings();
  const creditCards = useCreditCards(today);
  const subs = useSubscriptions(today);
  // The subscription check is today's: it belongs to the month just ended only.
  const latest = useMonthSpan(null, today);
  const justEnded = span !== null && latest !== null && latest.month === span.month;
  const [change, setChange] = useState<PickedChange | null | undefined>(undefined);

  const summary = span && budget.summary?.start === span.start ? budget.summary : null;
  const budgetReady = budget.budget !== undefined && (budget.budget === null || summary !== null);
  useEffect(() => {
    if (!span || !latest || !subs || !debtSettings || !budgetReady) return;
    let alive = true;
    void (async () => {
      const over = mostOver(summary);
      const asked = justEnded ? subs.check.items.filter((i) => i.ask) : [];
      const askedYearly = asked.map((i) => i.yearly_cents);
      const askedNames = asked.map((i) => i.label);
      let debt = null;
      if (debtSettings.debts.length > 0) {
        const add = over?.over_cents ?? DEBT_ADD_CENTS;
        const r = await whatIfDebt(
          debtInputs(debtSettings.debts),
          debtSettings.extra,
          add,
          today,
          debtSettings.order,
        );
        debt = {
          interest_saved_cents: r.interest_saved_cents,
          months: r.before.months,
          add_cents: add,
          months_after: r.after.months,
          month_before: r.before.debt_free_month,
          month_after: r.after.debt_free_month,
        };
      }
      const options = buildOptions({ over, askedYearly, askedNames, debt });
      const { pick } = await oneChange(
        options.map((o) => o.candidate),
        ONE_CHANGE_ORDER,
      );
      const option = pick ? options[pick.index] : undefined;
      await db.computed_results.put({
        id: `one_change:${span.end}`,
        kind: "one_change",
        as_of: span.end,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: { candidates: options.map((o) => o.candidate), pick },
        computed_at: new Date().toISOString(),
      });
      if (alive) setChange(pick && option ? { option, pick } : null);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, span, latest, justEnded, subs, debtSettings, budgetReady, summary, today]);

  if (!span) return null;
  const cards = (creditCards ?? [])
    .map((view) => ({ view, month: view.trend.months.find((m) => m.month === span.month) }))
    .filter((c): c is { view: CreditCardView; month: CardMonth } => c.month !== undefined);
  return {
    span,
    how: how && how.current.start === span.start ? how : undefined,
    budget: { ...budget, summary },
    jars,
    plan,
    cards,
    subs: justEnded ? subs : undefined,
    change,
  };
}
