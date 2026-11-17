import { daysInMonthOf, utcMs } from "@stackd/rules/dates";
import { Card, List, ProgressBar } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { GroupSummary } from "../../data/api.ts";
import type { Budget, Goal } from "../../data/db.ts";
import type { BudgetSummary, NextMoveFacts } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { BUCKET_LABELS } from "../budget/RuleView.tsx";
import { splitLabel } from "../budget/split.ts";
import { GoalRow } from "../goals/GoalCard.tsx";
import { percentText } from "../groups/ChallengesTab.tsx";
import { BucketBars } from "../insights/InsightCard.tsx";

/**
 * Home's cards for what the person set up (owner, November 17, 2026): Budget, Jars and the
 * challenge each lead with one word, one short line and a picture, as every other Home card does,
 * and sit right after This month.
 */

function dayParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** Days left in this month, today included. */
export function daysLeftInMonth(today: string): number {
  const [y, m, d] = dayParts(today);
  return daysInMonthOf(y, m) - d + 1;
}

/** Day n of a challenge's length, both ends included; clamped to its span. */
export function challengeDay(today: string, start: string, end: string): [number, number] {
  const day = (iso: string) => {
    const [y, m, d] = dayParts(iso);
    return Math.round(utcMs(y, m - 1, d) / 86_400_000);
  };
  const total = day(end) - day(start) + 1;
  return [Math.max(1, Math.min(total, day(today) - day(start) + 1)), total];
}

/** What's over in the budget: a bucket (50/30/20) or the expense lines (zero-based). */
function overLine(budget: Budget, summary: BudgetSummary): string | null {
  if (budget.method === "zero_based") {
    const over = summary.categories.filter(
      (c) => c.planned_cents !== null && c.spent_cents > c.planned_cents,
    );
    if (!over.length) return null;
    const cents = over.reduce((s, c) => s + c.spent_cents - (c.planned_cents ?? 0), 0);
    return `${over.length} ${over.length === 1 ? "line" : "lines"} ${formatCents(cents)} over plan`;
  }
  const over = summary.buckets.find((b) => b.left_cents < 0);
  return over
    ? `${BUCKET_LABELS[over.bucket][0]} ${formatCents(-over.left_cents)} over plan`
    : null;
}

export function BudgetHomeCard({
  budget,
  summary,
  today,
}: {
  budget: Budget;
  summary: BudgetSummary | null;
  today: string;
}) {
  const over = summary ? overLine(budget, summary) : null;
  // Room left this month to spend: needs and wants (or every expense line), never the save part.
  const spendable = summary
    ? budget.method === "zero_based"
      ? summary.categories
          .filter((c) => c.bucket !== "save" && c.planned_cents !== null)
          .reduce((s, c) => s + Math.max(0, (c.planned_cents ?? 0) - c.spent_cents), 0)
      : summary.buckets
          .filter((b) => b.bucket !== "save")
          .reduce((s, b) => s + Math.max(0, b.left_cents), 0)
    : 0;
  const days = daysLeftInMonth(today);
  const unassigned = summary?.left_to_assign_cents ?? 0;
  const line = !summary
    ? "Working it out…"
    : over
      ? over
      : budget.method === "zero_based" && unassigned > 0
        ? `${formatCents(unassigned)} left to assign`
        : `${formatCents(spendable)} left · ${days} ${days === 1 ? "day" : "days"} to go`;
  return (
    <Link to="/budget" className="card-link" aria-label="Open Budget">
      <Card as="section" aria-labelledby="home-budget">
        <h2 className="sk-card__title" id="home-budget">
          Budget · {budget.method === "50_30_20" ? splitLabel(budget.split_bps) : "Zero-based"}
        </h2>
        {summary ? <Word>{over ? "Over" : "On track"}</Word> : null}
        <p className="sk-card__eyebrow">{line}</p>
        {summary ? <BucketBars buckets={summary.buckets} /> : null}
      </Card>
    </Link>
  );
}

export function JarsHomeCard({
  jars,
  saved,
  behind,
  today,
}: {
  jars: Goal[];
  saved: ReadonlyMap<string, number>;
  behind: NextMoveFacts["behind_goal"];
  today: string;
}) {
  const shown = jars.slice(0, 3);
  // A word of progress only once money is in a jar (owner, November 17, 2026).
  const started = jars.some((g) => (saved.get(g.id) ?? 0) > 0);
  return (
    <Card as="section" aria-labelledby="home-jars">
      <h2 className="sk-card__title" id="home-jars">
        Jars · {jars.length}
      </h2>
      <Word>{behind ? "Behind" : started ? "Saving" : "Start"}</Word>
      <p className="sk-card__eyebrow">
        {behind
          ? `${behind.title} is ${formatCents(behind.behind_cents)} behind its pace`
          : started
            ? `${shown[0]?.title ?? "Your jar"} leads · tap one to add`
            : "Nothing in yet · tap a jar to add"}
      </p>
      <List aria-label="Your top jars">
        {shown.map((g) => (
          <GoalRow key={g.id} goal={g} asOf={today} />
        ))}
      </List>
      <Link to="/goals" className="setup__all">
        {jars.length > shown.length ? `See all ${jars.length} jars` : "Open Goals"}
      </Link>
    </Card>
  );
}

export function ChallengeHomeCard({ group, today }: { group: GroupSummary; today: string }) {
  const reached = group.my_progress_bps >= 10000;
  const started = group.my_progress_bps > 0;
  const [day, total] = challengeDay(today, group.start_date, group.end_date);
  return (
    <Link
      to={`/groups/${group.id}`}
      className="card-link"
      aria-label={`Open challenge ${group.name}`}
    >
      <Card as="section" aria-labelledby="home-challenge">
        <h2 className="sk-card__title" id="home-challenge">
          Challenge
        </h2>
        <Word>{reached ? "Reached" : started ? "Saving" : "Start"}</Word>
        <p className="sk-card__eyebrow">
          {group.name} · {percentText(group.my_progress_bps)} · day {day} of {total}
        </p>
        <ProgressBar
          fraction={Math.max(0, Math.min(1, group.my_progress_bps / 10000))}
          label={`${group.name} progress`}
          valueText={`${percentText(group.my_progress_bps)} of your target, day ${day} of ${total}`}
        />
      </Card>
    </Link>
  );
}
