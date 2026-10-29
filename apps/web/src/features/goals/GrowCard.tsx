import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { AmountSlider } from "../../app/layout/AmountSlider.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Goal, ignoreClosed } from "../../data/db.ts";
import {
  engine,
  type GrowPace,
  type GrowPlan,
  type GrowReach,
  growGoalPace,
  growGoalPlan,
  growGoalReach,
} from "../../engine/bridge.ts";
import { formatCents, formatMonth } from "../../lib/format.ts";
import { percentText } from "../../lib/ownValues.ts";
import { GrowChart } from "./GrowChart.tsx";
import { growLineOf, growMessage, reachLineOf } from "./grow.ts";

const PACE_WORD: Record<GrowPace["status"], string> = {
  ahead: "Ahead",
  on_track: "On track",
  behind: "Behind",
};

/**
 * A grows jar's one monthly amount from now (`growth.goal_plan`, the figure GrowCard shows), for
 * the goal list and the quick deposit chip; null while working it out, when the jar doesn't grow
 * or the plan can't be made. A grows jar never shows the flat weekly pace beside it.
 */
export function useGrowMonthly(
  goal: Goal,
  savedCents: number | null,
  today: string,
): number | null {
  const grow = goal.grow;
  const end = goal.end_date;
  const [monthly, setMonthly] = useState<number | null>(null);
  useEffect(() => {
    if (!grow || !end || savedCents === null) {
      setMonthly(null);
      return;
    }
    let alive = true;
    void growGoalPlan({
      today_cost_cents: grow.today_cents,
      cost_rise_bps: grow.cost_rise_bps,
      return_bps: grow.return_bps,
      target_date: end,
      priced_on: grow.priced_on,
      saved_cents: Math.max(0, savedCents),
      as_of: today,
    })
      .then((plan) => {
        if (alive) setMonthly(plan.already_enough ? 0 : plan.monthly_needed_cents);
      })
      .catch(() => {
        if (alive) setMonthly(null);
      });
    return () => {
      alive = false;
    };
  }, [grow, end, savedCents, today]);
  return monthly;
}

/**
 * A jar that grows over time (October 28, 2026): the monthly amount from now through
 * `growth.goal_plan`, and Ahead / On track / Behind from `growth.goal_pace` (deposits so far
 * against the plan made on the day it was priced). Keeps the jar's target at the future cost.
 */
export function GrowCard({
  goal,
  savedCents,
  today,
}: {
  goal: Goal;
  savedCents: number;
  today: string;
}) {
  const { db } = useDb();
  const grow = goal.grow;
  const [state, setState] = useState<{ plan: GrowPlan; pace: GrowPace } | { error: string } | null>(
    null,
  );

  useEffect(() => {
    if (!grow || !goal.end_date) return;
    const end = goal.end_date;
    let alive = true;
    void (async () => {
      const base = {
        today_cost_cents: grow.today_cents,
        cost_rise_bps: grow.cost_rise_bps,
        return_bps: grow.return_bps,
        target_date: end,
        priced_on: grow.priced_on,
      };
      try {
        const plan = await growGoalPlan({
          ...base,
          saved_cents: Math.max(0, savedCents),
          as_of: today,
        });
        const start = await growGoalPlan({ ...base, saved_cents: 0, as_of: grow.priced_on });
        const pace = await growGoalPace({
          plan_monthly_cents: start.monthly_needed_cents,
          deposited_cents: savedCents,
          start_date: grow.priced_on,
          as_of: today,
        });
        if (!alive) return;
        setState({ plan, pace });
        if (plan.future_cost_cents !== goal.target_cents)
          await db.goals.update(goal.id, {
            target_cents: plan.future_cost_cents,
            updated_at: new Date().toISOString(),
          });
        await db.computed_results.put({
          id: `grow_plan:${goal.id}:${today}`,
          kind: "grow_plan",
          as_of: today,
          rules_version: engine.rulesVersion ?? "unknown",
          payload: { plan, pace },
          computed_at: new Date().toISOString(),
        });
      } catch (err) {
        if (alive) setState({ error: growMessage(err) });
      }
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, goal.id, goal.target_cents, goal.end_date, grow, savedCents, today]);

  // The slider's amount: the plan's own month until the person moves it (October 29, 2026).
  const [own, setOwn] = useState<number | null>(null);
  const planMonthly =
    state && "plan" in state
      ? state.plan.already_enough
        ? 0
        : state.plan.monthly_needed_cents
      : null;
  const monthly = own ?? planMonthly;
  const [reach, setReach] = useState<GrowReach | null>(null);
  useEffect(() => {
    if (!grow || !goal.end_date || monthly === null) return;
    let alive = true;
    void growGoalReach({
      today_cost_cents: grow.today_cents,
      cost_rise_bps: grow.cost_rise_bps,
      return_bps: grow.return_bps,
      target_date: goal.end_date,
      priced_on: grow.priced_on,
      saved_cents: Math.max(0, savedCents),
      monthly_cents: monthly,
      as_of: today,
    })
      .then((r) => {
        if (alive) setReach(r);
      })
      .catch(() => {
        if (alive) setReach(null);
      });
    return () => {
      alive = false;
    };
  }, [grow, goal.end_date, savedCents, monthly, today]);

  if (!grow || !goal.end_date) return null;
  return (
    <Card as="section" aria-label="Grows over time">
      {state && "plan" in state ? (
        <>
          {reach && monthly !== null ? <GrowChart reach={reach} monthly={monthly} /> : null}
          <Word>{state.plan.already_enough ? "Ahead" : PACE_WORD[state.pace.status]}</Word>
          <p role="status">
            {state.plan.already_enough
              ? `What you have could grow to ${formatCents(state.plan.saved_grows_to_cents)} by then.`
              : growLineOf(
                  state.plan.monthly_needed_cents,
                  state.plan.future_cost_cents,
                  goal.end_date,
                )}
          </p>
          {/* Two labelled ends, so the bar reads as a cost rising, never as progress. */}
          <p className="grow-ends">
            <span>{formatCents(grow.today_cents)} today</span>
            <span aria-hidden="true"> → </span>
            <span>
              {formatCents(state.plan.future_cost_cents)} by {formatMonth(goal.end_date)}
            </span>
          </p>
          {monthly !== null && planMonthly !== null ? (
            <AmountSlider
              label="If I put in"
              value={monthly}
              max={Math.max(10000, planMonthly * 2)}
              onChange={setOwn}
              own="Your own amount a month"
            />
          ) : null}
          {reach ? (
            <p className="grow__result" aria-live="polite">
              {reachLineOf(reach, goal.end_date)}
            </p>
          ) : null}
          <p className="sk-card__eyebrow">
            {formatCents(grow.today_cents)} today, rising {percentText(grow.cost_rise_bps)} a year.
            What you save growing {percentText(grow.return_bps)} a year.
          </p>
        </>
      ) : state ? (
        <p role="status">{state.error}</p>
      ) : (
        <p className="sr-only" role="status">
          Working it out
        </p>
      )}
      <p className="sk-card__eyebrow">
        An illustration at the rates you chose, not a prediction or advice.
      </p>
    </Card>
  );
}
