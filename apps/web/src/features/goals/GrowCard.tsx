import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Goal, ignoreClosed } from "../../data/db.ts";
import {
  engine,
  type GrowPace,
  type GrowPlan,
  growGoalPace,
  growGoalPlan,
} from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { percentText } from "../../lib/ownValues.ts";
import { growLineOf, growMessage } from "./grow.ts";

const PACE_WORD: Record<GrowPace["status"], string> = {
  ahead: "Ahead",
  on_track: "On track",
  behind: "Behind",
};

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

  if (!grow || !goal.end_date) return null;
  return (
    <Card as="section" aria-label="Grows over time">
      {state && "plan" in state ? (
        <>
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
          <div
            className="grow-bars"
            role="img"
            aria-label={`Costs ${formatCents(grow.today_cents)} today, ${formatCents(state.plan.future_cost_cents)} then`}
          >
            <span
              className="grow-bars__now"
              style={{ width: `${barPct(grow.today_cents, state.plan.future_cost_cents)}%` }}
            />
          </div>
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
        An illustration at the rates you chose, not a prediction or advice.{" "}
        <Link to={`/what-if?goal=${encodeURIComponent(goal.id)}`}>What if I put in more?</Link>
      </p>
    </Card>
  );
}

/** Today's cost as a share of the future cost, for the bar's width (layout only). */
function barPct(today: number, future: number): number {
  return future > 0 ? Math.max(4, Math.min(100, Math.round((today / future) * 100))) : 100;
}
