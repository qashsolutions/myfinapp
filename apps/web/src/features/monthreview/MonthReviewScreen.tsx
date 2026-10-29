import "../auth/auth.css";
import "../goals/goals.css";
import "../groups/groups.css";
import "../home/home.css";
import "../insights/insights.css";
import "../pwa/pwa.css";
import "../ranges/ranges.css";
import "./monthreview.css";

import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Category, ignoreClosed } from "../../data/db.ts";
import { addMonths } from "../../engine/bridge.ts";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { BUCKET_LABELS } from "../budget/RuleView.tsx";
import { useLookups } from "../entries/useEntries.ts";
import { categoryName, FixedFlexibleMonthCard, keptRateText } from "../fixed/FixedFlexibleCard.tsx";
import { HeroBars } from "../home/HomeVisuals.tsx";
import { BucketBars } from "../insights/InsightCard.tsx";
import {
  bucketsOver,
  linesOver,
  markReviewDone,
  monthParam,
  type PickedChange,
  whatIfLink,
} from "./monthReview.ts";
import { type MonthReview, useMonthReview, useMonthSpan } from "./useMonthReview.ts";

const DISCLAIMER = "An illustration from your own numbers, not advice.";
const PACE: Record<string, string> = { ahead: "Ahead", on_track: "On track", behind: "Behind" };

function Section({
  id,
  title,
  word,
  line,
  children,
}: {
  id: string;
  title: string;
  word: string;
  line: string;
  children?: React.ReactNode;
}) {
  return (
    <Card as="section" aria-labelledby={`review-${id}`}>
      <h2 className="sk-card__title" id={`review-${id}`}>
        {title}
      </h2>
      <Word>{word}</Word>
      <p className="review-month__line">{line}</p>
      {children}
    </Card>
  );
}

function HowItWent({ review }: { review: MonthReview }) {
  const how = review.how;
  if (!how || how.word === "Start") return null;
  const now = how.current;
  const before = how.before;
  const compare =
    before.in_cents > 0 || before.out_cents > 0
      ? `${formatMonth(before.start)}: ${keptRateText(before)}`
      : null;
  return (
    <Section id="how" title="How it went" word={how.word} line={keptRateText(now)}>
      <HeroBars inCents={now.in_cents} outCents={now.out_cents} />
      <p className="home__numbers">
        <span>In {formatCents(now.in_cents)}</span>
        <span aria-hidden="true">·</span>
        <span>Out {formatCents(now.out_cents)}</span>
        <span aria-hidden="true">·</span>
        <span>Kept {formatCents(now.kept_cents)}</span>
      </p>
      {compare ? <p className="sk-card__eyebrow">{compare}</p> : null}
    </Section>
  );
}

function BudgetSection({
  review,
  categories,
}: {
  review: MonthReview;
  categories: Map<string, Category> | undefined;
}) {
  const summary = review.budget.summary;
  if (!summary) return null;
  if (summary.method === "zero_based") {
    const over = linesOver(summary);
    const top = over[0];
    const bars = (over.length ? over : [])
      .slice(0, 3)
      .map((o) => summary.categories.find((c) => c.category_id === o.category_id))
      .filter((c) => c !== undefined)
      .map((c) => ({
        bucket: categoryName(c.category_id, categories),
        planned_cents: c.planned_cents ?? 0,
        spent_cents: c.spent_cents,
      }));
    return (
      <Section
        id="budget"
        title="Budget"
        word={top ? "Over" : "Steady"}
        line={
          top
            ? `${over.length === 1 ? "1 line" : `${over.length} lines`} over · ${categoryName(top.category_id, categories)} ${formatCents(top.over_cents)} over`
            : "Every line on plan"
        }
      >
        {bars.length ? <BucketBars buckets={bars} /> : null}
      </Section>
    );
  }
  const top = bucketsOver(summary)[0];
  return (
    <Section
      id="budget"
      title="Budget"
      word={top ? "Over" : "Steady"}
      line={
        top
          ? `${BUCKET_LABELS[top.bucket][0]} ${formatCents(top.over_cents)} over`
          : "Needs and wants on plan"
      }
    >
      <BucketBars buckets={summary.buckets} />
    </Section>
  );
}

function JarsSection({ review }: { review: MonthReview }) {
  const jars = review.jars;
  if (!jars || jars.count === 0) return null;
  const word = jars.reached.length ? "Reached" : jars.totalCents > 0 ? "Saved" : "Quiet";
  const line =
    jars.totalCents > 0
      ? `${formatCents(jars.totalCents)} new money into ${jars.deposits.length === 1 ? "1 jar" : `${jars.deposits.length} jars`}`
      : "No new money into jars this month";
  const biggest = Math.max(1, ...jars.deposits.map((d) => d.cents));
  return (
    <Section id="jars" title="Jars" word={word} line={line}>
      {jars.deposits.length ? (
        <ul className="recap__list">
          {jars.deposits.map((d) => (
            <li key={d.goal.id} className="recap__jar">
              <span className="hero-split">
                <Link to={`/goals/${d.goal.id}`} className="auth__link">
                  {d.goal.title}
                </Link>
                <span>{formatCents(d.cents)}</span>
              </span>
              <span className="goal-row__bar" aria-hidden="true">
                <span
                  className="goal-row__fill goal-row__fill--done"
                  style={{ width: `${Math.max(4, (d.cents / biggest) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {jars.reached.map((g) => (
        <p key={`reached-${g.id}`}>{g.title} reached its target.</p>
      ))}
      {jars.grows.map((g) => (
        <p key={`grow-${g.goal.id}`} className="sk-card__eyebrow">
          {g.goal.title}: {PACE[g.pace] ?? ""} at the month's end
        </p>
      ))}
    </Section>
  );
}

function DebtSection({ review }: { review: MonthReview }) {
  const plan = review.plan;
  const cards = review.cards;
  if (!plan && cards.length === 0) return null;
  const first = cards[0]?.month;
  const word = plan
    ? plan.stalled
      ? "Stalled"
      : "Debt-free"
    : first && first.net_cents > 0
      ? "Growing"
      : first && first.net_cents < 0
        ? "Shrinking"
        : "Steady";
  const line = plan
    ? plan.stalled
      ? "Payments don't catch the interest yet"
      : `At today's plan: by ${plan.debt_free_month ? formatMonth(`${plan.debt_free_month}-01`) : "now"}`
    : "Card spending against payments";
  return (
    <Section id="debt" title="Debt" word={word} line={line}>
      {cards.length ? (
        <ul className="review-month__list" aria-label="Cards this month">
          {cards.map((c) => (
            <li key={c.view.account.id}>
              {c.view.account.label}: spent {formatCents(c.month.spent_cents)}, paid{" "}
              {formatCents(c.month.paid_cents)}
            </li>
          ))}
        </ul>
      ) : null}
      {plan ? (
        <p>
          <Link to="/bills?tab=debt" className="auth__link">
            Open Debt payoff
          </Link>
        </p>
      ) : null}
    </Section>
  );
}

function SubscriptionsSection({ review }: { review: MonthReview }) {
  const subs = review.subs;
  if (!subs || subs.subscriptions.length === 0) return null;
  const asked = subs.check.items.filter((i) => i.ask);
  const yearly = asked.reduce((sum, i) => sum + i.yearly_cents, 0);
  return (
    <Section
      id="subs"
      title="Subscriptions"
      word={asked.length ? "Check" : "All good"}
      line={
        asked.length
          ? `${asked.length} to check · ${formatCents(yearly)} a year`
          : `${subs.subscriptions.length === 1 ? "1 subscription" : `${subs.subscriptions.length} subscriptions`}, nothing to check`
      }
    >
      <p>
        <Link to="/subscriptions" className="auth__link">
          Open Subscriptions
        </Link>
      </p>
    </Section>
  );
}

/** "Trim Dining by $120 a month → $1,440 a year": an option from their own numbers. */
export function changeText(
  change: PickedChange,
  categories: Map<string, Category> | undefined,
): string {
  const { option, pick } = change;
  const yearly = formatCents(pick.yearly_cents);
  if (pick.kind === "over_plan" && option.over) {
    const what = option.over.bucket
      ? BUCKET_LABELS[option.over.bucket][0]
      : categoryName(option.over.category_id, categories);
    return `Trim ${what} by ${formatCents(option.over.over_cents)} a month → ${yearly} a year`;
  }
  if (pick.kind === "subscription_check") {
    const n = option.count ?? 0;
    return `Check ${n === 1 ? "1 subscription" : `${n} subscriptions`} → ${yearly} a year`;
  }
  return `Put ${formatCents(option.addCents ?? 0)} a month on your debts → about ${yearly} a year less interest`;
}

function OneChange({
  review,
  categories,
}: {
  review: MonthReview;
  categories: Map<string, Category> | undefined;
}) {
  const change = review.change;
  if (!change) return null;
  const link = whatIfLink(change.option);
  return (
    <Card as="section" aria-labelledby="review-change">
      <h2 className="sk-card__title" id="review-change">
        One change
      </h2>
      <Word>Try</Word>
      <p className="review-month__line" role="status">
        {changeText(change, categories)}
      </p>
      <p>
        {link ? (
          <Link to={link} className="auth__link">
            Try it in What if
          </Link>
        ) : (
          <Link to="/subscriptions" className="auth__link">
            Look at them in Subscriptions
          </Link>
        )}
      </p>
      <p className="auth__fineprint">{DISCLAIMER}</p>
    </Card>
  );
}

/**
 * Your month (October 28, 2026; docs/spec.md "Your month"): one whole month's pieces side by
 * side, each from the hook its own screen uses, and one change picked by `insights.one_change`.
 * Sections with nothing for the month are left out. Nothing leaves the device.
 */
export function MonthReviewScreen() {
  const { db } = useDb();
  const navigate = useNavigate();
  const today = todayIso();
  const [params, setParams] = useSearchParams();
  const span = useMonthSpan(monthParam(params.get("month")), today);
  const review = useMonthReview(span, today);
  const lookups = useLookups();
  const firstMonth = useLiveQuery(
    async () => (await db.entries.orderBy("date").first())?.date.slice(0, 7) ?? null,
    [db],
  );
  const [lastMonth, setLastMonth] = useState<string | null>(null);
  const [steps, setSteps] = useState<{ earlier: string; later: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const last = (await addMonths(today, -1)).slice(0, 7);
      if (alive) setLastMonth(last);
      if (!span) return;
      const earlier = (await addMonths(span.start, -1)).slice(0, 7);
      const later = (await addMonths(span.start, 1)).slice(0, 7);
      if (alive) setSteps({ earlier, later });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [span, today]);

  const month = span?.month ?? null;
  const canLater = month !== null && lastMonth !== null && compareText(month, lastMonth) < 0;
  const canEarlier =
    month !== null && typeof firstMonth === "string" && compareText(firstMonth, month) < 0;
  const go = (m: string) => setParams({ month: m }, { replace: true });

  return (
    <>
      <ScreenHeader
        title="Your month"
        back="/insights"
        actions={null}
      />
      <div className="range-stepper">
        <button
          type="button"
          className="range-stepper__btn"
          onClick={() => steps && go(steps.earlier)}
          disabled={!canEarlier || !steps}
        >
          ‹ Earlier
        </button>
        <span className="range-stepper__label" aria-live="polite">
          {span ? formatMonth(span.start) : ""}
        </span>
        <button
          type="button"
          className="range-stepper__btn"
          onClick={() => steps && go(steps.later)}
          disabled={!canLater || !steps}
        >
          Later ›
        </button>
      </div>
      {review ? (
        <>
          <HowItWent review={review} />
          <BudgetSection review={review} categories={lookups?.categories} />
          <FixedFlexibleMonthCard asOf={review.span.start} today={today} />
          <JarsSection review={review} />
          <DebtSection review={review} />
          <SubscriptionsSection review={review} />
          <OneChange review={review} categories={lookups?.categories} />
          {review.how?.word === "Start" ? (
            <Card as="section" aria-label="Nothing this month">
              <Word>Start</Word>
              <p>Nothing logged in {formatMonth(review.span.start)}.</p>
            </Card>
          ) : null}
          <div className="install-actions">
            <Button
              onClick={() => {
                void markReviewDone(db, review.span.month)
                  .then(() => navigate("/"))
                  .catch(ignoreClosed);
              }}
            >
              Done
            </Button>
          </div>
          <p className="auth__fineprint">
            Facts from your own entries on this device. {DISCLAIMER}
          </p>
        </>
      ) : (
        <p className="sr-only" role="status">
          Loading
        </p>
      )}
    </>
  );
}
