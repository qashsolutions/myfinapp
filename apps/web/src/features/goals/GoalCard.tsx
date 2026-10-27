import { Card, Chip, ListRow, ProgressBar } from "@stackd/ui";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { Goal } from "../../data/db.ts";
import type { GoalProgress } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { useGoalProgress } from "./useGoals.ts";

export const CADENCE_WORDS: Record<string, string> = {
  weekly: "every week",
  biweekly: "every 2 weeks",
  monthly: "every month",
  payday: "every paycheck",
};

export function goalSentence(goal: Goal): string {
  switch (goal.kind) {
    case "save":
      if (goal.is_ongoing)
        return `Save ${formatCents(goal.per_period_cents ?? 0)} for ${goal.title} ${CADENCE_WORDS[goal.cadence ?? "monthly"]}`;
      return `Save ${formatCents(goal.target_cents ?? 0)} for ${goal.title}${goal.end_date ? ` by ${formatDay(goal.end_date)}` : ""}${goal.cadence ? `, ${CADENCE_WORDS[goal.cadence]}` : ""}`;
    case "payoff":
      return `Pay off ${formatCents(goal.target_cents ?? 0)} on ${goal.title}${goal.end_date ? ` by ${formatDay(goal.end_date)}` : ""}`;
    case "spend_less":
      return `Spend ${formatCents(goal.target_cents ?? 0)} less on ${goal.title} this month`;
    case "habit":
      return `${goal.target_days} days of ${goal.title} from ${formatDay(goal.start_date)}`;
  }
}

/** "$200 of $500" (or days for a habit) and the pace line, from the engine's progress. */
function progressText(goal: Goal, p: GoalProgress | null): { amount: string; pace: string } {
  if (!p) return { amount: "", pace: "" };
  const amount =
    goal.kind === "habit"
      ? `${p.current} of ${p.target} days`
      : `${formatCents(p.current)} of ${formatCents(p.target)}`;
  const pace =
    p.status === "reached"
      ? "Reached"
      : p.status === "overdue"
        ? "Overdue"
        : p.weekly_pace === null
          ? "No deadline"
          : goal.kind === "habit"
            ? `${p.weekly_pace} ${p.weekly_pace === 1 ? "day" : "days"}/week to go`
            : `${formatCents(p.weekly_pace)}/week`;
  return { amount, pace };
}

/** One goal in the list (mockup F4Goals): title, progress, amount and weekly pace. */
export function GoalCard({ goal, asOf }: { goal: Goal; asOf: string }) {
  const navigate = useNavigate();
  const view = useGoalProgress(goal, asOf);
  const p = view?.progress ?? null;
  const fraction = p ? p.display_bps / 10000 : 0;
  const { amount, pace } = progressText(goal, p);
  return (
    <Card
      as="div"
      aria-label={goal.title}
      className="card-link"
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/goals/${goal.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/goals/${goal.id}`);
        }
      }}
    >
      <div className="goal-card__top">
        <span className="goal-card__title">{goal.title}</span>
        {goal.paused_at ? (
          <Chip tone="pending">Paused</Chip>
        ) : goal.is_ongoing ? (
          <Chip tone="neutral">Ongoing</Chip>
        ) : p?.status === "reached" ? (
          <Chip tone="success">Reached</Chip>
        ) : p?.status === "overdue" ? (
          <Chip tone="warning">Overdue</Chip>
        ) : (
          <Chip tone="neutral">
            {goal.kind === "save"
              ? "Jar"
              : goal.kind === "payoff"
                ? "Pay off"
                : goal.kind === "spend_less"
                  ? "Spend less"
                  : "Habit"}
          </Chip>
        )}
      </div>
      <Word>
        {goal.paused_at
          ? "Paused"
          : p?.status === "reached"
            ? "Reached"
            : p?.status === "overdue"
              ? "Behind"
              : "Saving"}
      </Word>
      <span className="goal-card__sub">{goalSentence(goal)}</span>
      {goal.why_text ? <span className="goal-card__sub goal-why">“{goal.why_text}”</span> : null}
      <ProgressBar
        fraction={fraction}
        label={`${goal.title} progress`}
        valueText={amount || "No progress yet"}
        tone={p?.status === "overdue" ? "warning" : undefined}
      />
      <div className="goal-card__bottom">
        <span className="goal-card__amount">{amount}</span>
        <span className="goal-card__pace">{pace}</span>
      </div>
    </Card>
  );
}

/**
 * One goal as a single line (every jar after the top one on the Goals tab): the percentage in a
 * small ring, the name, saved of target, and the pace or state on the right. Opens the goal.
 */
export function GoalRow({ goal, asOf }: { goal: Goal; asOf: string }) {
  const navigate = useNavigate();
  const view = useGoalProgress(goal, asOf);
  const p = view?.progress ?? null;
  const { amount, pace } = progressText(goal, p);
  const pct = goal.is_ongoing || !p ? null : Math.round(p.display_bps / 100);
  const state = goal.paused_at ? "Paused" : goal.is_ongoing ? "Ongoing" : pace;
  return (
    <ListRow
      href={`/goals/${goal.id}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/goals/${goal.id}`);
      }}
      leading={
        <span
          className="goal-ring"
          style={{ "--goal-pct": `${pct ?? 0}%` } as CSSProperties}
          aria-hidden="true"
        >
          {pct === null ? "·" : `${pct}%`}
        </span>
      }
      label={goal.title}
      sublabel={
        goal.is_ongoing ? (
          goalSentence(goal)
        ) : (
          <>
            {amount || "No progress yet"}
            {/* A bar under the amount (October 23, 2026): the row reads at a glance. */}
            {pct !== null ? (
              <span className="goal-row__bar" aria-hidden="true">
                <span
                  className={`goal-row__fill goal-row__fill--${p?.status === "reached" ? "done" : p?.status === "overdue" ? "late" : "on"}`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </span>
            ) : null}
          </>
        )
      }
      value={state}
      valueTone={p?.status === "overdue" ? "warning" : p?.status === "reached" ? "success" : "sub"}
    />
  );
}
