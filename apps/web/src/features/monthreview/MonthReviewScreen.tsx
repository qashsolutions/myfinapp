import "../auth/auth.css";
import "../goals/goals.css";
import "../groups/groups.css";
import "../home/home.css";
import "../insights/insights.css";
import "../pwa/pwa.css";
import "../ranges/ranges.css";
import "../fixed/fixed.css";
import "./monthreview.css";

import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Arranged } from "../../app/layout/Arranged.tsx";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Category, ignoreClosed } from "../../data/db.ts";
import { addMonths } from "../../engine/bridge.ts";
import {
  formatCents,
  formatCentsTidy,
  formatMonth,
  formatMonthShort,
  todayIso,
} from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { BUCKET_LABELS } from "../budget/RuleView.tsx";
import { useLookups } from "../entries/useEntries.ts";
import { categoryName, FixedFlexibleMonthCard, keptRateText } from "../fixed/FixedFlexibleCard.tsx";
import { activeMonths, KeptTrend, ratePct } from "../fixed/FixedVisuals.tsx";
import { HeroBars } from "../home/HomeVisuals.tsx";
import { BucketBars, Ring } from "../insights/InsightCard.tsx";
import { MonthReviewAdjust } from "./MonthReviewAdjust.tsx";
import {
  bucketsOver,
  linesOver,
  markReviewDone,
  monthParam,
  type PickedChange,
  REVIEW_SECTIONS,
  type ReviewSection,
  useMonthReviewPrefs,
  whatIfLink,
} from "./monthReview.ts";
import { BeforeAfterBars, CountChip, DebtLine } from "./ReviewVisuals.tsx";
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

/**
 * The one-glance summary that opens the screen: Kept as the hero, in against out, and the kept
 * rate for this month and the five before it, this month drawn full strength.
 */
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
    <Card as="section" aria-labelledby="review-how">
      <h2 className="sk-card__title" id="review-how">
        How it went
      </h2>
      <Word>{how.word}</Word>
      <p className="sk-card__hero review-month__hero">
        {formatCents(Math.abs(now.kept_cents))}
        {/* The word Kept / Over already names the amount; after Up / Down / Steady the unit says it. */}
        {how.word === "Kept" || how.word === "Over" ? null : (
          <>
            {" "}
            <span className="sk-card__hero-unit">{now.kept_cents < 0 ? "over" : "kept"}</span>
          </>
        )}
      </p>
      {/* The hero already says Kept: the line says what share of what came in, then the month
          before, so "kept" is never said three times over. */}
      {now.kept_rate_bps !== null || compare ? (
        <p className="review-month__line">
          {now.kept_rate_bps !== null ? `${ratePct(now.kept_rate_bps)} of what came in` : null}
          {now.kept_rate_bps !== null && compare ? " · " : null}
          {compare ? <span className="review-month__compare">{compare}</span> : null}
        </p>
      ) : null}
      <HeroBars inCents={now.in_cents} outCents={now.out_cents} />
      {activeMonths(how.months, now.start).length > 1 ? (
        <>
          <p className="sk-card__eyebrow review-month__trend-h">Kept rate by month</p>
          <KeptTrend months={how.months} highlight={now.start} />
        </>
      ) : null}
    </Card>
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
    // The lines most over, else the three biggest lines, each against its plan.
    const shown = over.length
      ? over.slice(0, 3).map((o) => summary.categories.find((c) => c.category_id === o.category_id))
      : summary.categories
          .filter((c) => (c.planned_cents ?? 0) > 0)
          .sort((a, b) => b.spent_cents - a.spent_cents)
          .slice(0, 3);
    const bars = shown
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
  return (
    <Section id="jars" title="Jars" word={word} line={line}>
      {jars.deposits.length ? (
        <ul className="review-jars">
          {jars.deposits.map((d) => {
            const bps = jars.progressBps.get(d.goal.id);
            return (
              <li key={d.goal.id} className="review-jars__row">
                {bps !== undefined ? (
                  <Ring pct={bps / 100} />
                ) : (
                  <span className="review-jars__dot" aria-hidden="true" />
                )}
                <span className="review-jars__text">
                  <Link to={`/goals/${d.goal.id}`} className="auth__link">
                    {d.goal.title}
                  </Link>
                  <span className="review-jars__new">+{formatCents(d.cents)} new</span>
                  {bps !== undefined ? (
                    <span className="sr-only">{Math.round(bps / 100)}% of its target</span>
                  ) : null}
                </span>
              </li>
            );
          })}
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
  // The month leads as the value (like Home's "$X kept"); "Debt-free" is the line, so the green
  // word never reads as a claim about today.
  const word = plan
    ? plan.stalled
      ? "Stalled"
      : plan.debt_free_month
        ? formatMonthShort(plan.debt_free_month)
        : "Clear"
    : first && first.net_cents > 0
      ? "Growing"
      : first && first.net_cents < 0
        ? "Shrinking"
        : "Steady";
  const line = plan
    ? plan.stalled
      ? "Payments don't catch the interest yet"
      : plan.debt_free_month
        ? "Debt-free at this pace"
        : "No balance left"
    : "Card spending against payments";
  return (
    <Section id="debt" title="Debt" word={word} line={line}>
      {plan && !plan.stalled && plan.debt_free_month && plan.series_cents.length > 1 ? (
        <DebtLine series={plan.series_cents} endMonth={plan.debt_free_month} />
      ) : null}
      {cards.map((c) => (
        <BeforeAfterBars
          key={c.view.account.id}
          label={`${c.view.account.label} this month`}
          rows={[
            {
              label: `${c.view.account.label} spent`,
              size: c.month.spent_cents,
              text: formatCents(c.month.spent_cents),
              tone: "out",
            },
            {
              label: "Paid",
              size: c.month.paid_cents,
              text: formatCents(c.month.paid_cents),
              tone: "in",
            },
          ]}
        />
      ))}
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
      <CountChip
        count={asked.length}
        label={`to check of ${subs.subscriptions.length === 1 ? "1 subscription" : `${subs.subscriptions.length} subscriptions`}`}
      />
      <p>
        <Link to="/subscriptions" className="auth__link">
          Open Subscriptions
        </Link>
      </p>
    </Section>
  );
}

/**
 * "Dining $120 less a month → $1,440 a year": a fact from their own numbers, never an
 * instruction. Whole dollars where the cents add nothing.
 */
export function changeText(
  change: PickedChange,
  categories: Map<string, Category> | undefined,
): string {
  const { option, pick } = change;
  const yearly = formatCentsTidy(pick.yearly_cents);
  if (pick.kind === "over_plan" && option.over) {
    const what = option.over.bucket
      ? BUCKET_LABELS[option.over.bucket][0]
      : categoryName(option.over.category_id, categories);
    return `${what} ${formatCentsTidy(option.over.over_cents)} less a month → ${yearly} a year`;
  }
  if (pick.kind === "subscription_check") {
    const n = option.count ?? 0;
    return `Check ${n === 1 ? "1 subscription" : `${n} subscriptions`} → ${yearly} a year`;
  }
  return `${formatCentsTidy(option.addCents ?? 0)} more a month on debts → about ${yearly} less interest a year`;
}

/** The one change's before and after: a month against a year, or the debt-free date sooner. */
function ChangePicture({ change }: { change: PickedChange }) {
  const { option, pick } = change;
  if (pick.kind === "over_plan" && option.over) {
    return (
      <BeforeAfterBars
        label="A month against a year"
        rows={[
          {
            label: "A month",
            size: option.over.over_cents,
            text: formatCentsTidy(option.over.over_cents),
            tone: "now",
          },
          {
            label: "A year",
            size: pick.yearly_cents,
            text: formatCentsTidy(pick.yearly_cents),
            tone: "after",
          },
        ]}
      />
    );
  }
  if (pick.kind === "subscription_check") {
    return (
      <BeforeAfterBars
        label="Each subscription to check, a year"
        rows={option.candidate.amounts_cents.map((cents, i) => ({
          label: option.names?.[i] ?? `Subscription ${i + 1}`,
          size: cents,
          text: formatCentsTidy(cents),
          tone: "out" as const,
        }))}
      />
    );
  }
  const s = option.sooner;
  if (!s || s.months_after === null || !s.month_before || !s.month_after) return null;
  return (
    <BeforeAfterBars
      label="Debt-free date, now and with the extra"
      rows={[
        {
          label: "Now",
          size: s.months_before,
          text: formatMonthShort(s.month_before),
          tone: "now",
        },
        {
          label: `+${formatCentsTidy(option.addCents ?? 0)} a month`,
          size: s.months_after,
          text: formatMonthShort(s.month_after),
          tone: "after",
        },
      ]}
    />
  );
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
      <ChangePicture change={change} />
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
 * Since October 29, 2026 it opens with a one-glance summary, every section leads with its own
 * picture, the sections can be reordered and hidden (Customize Your month), and Adjust sets the
 * Home card. Sections with nothing for the month are left out. Nothing leaves the device.
 */
export function MonthReviewScreen() {
  const { db } = useDb();
  const navigate = useNavigate();
  const today = todayIso();
  const [params, setParams] = useSearchParams();
  const span = useMonthSpan(monthParam(params.get("month")), today);
  const review = useMonthReview(span, today);
  const lookups = useLookups();
  const prefs = useMonthReviewPrefs();
  const [adjust, setAdjust] = useState(params.get("adjust") === "1");
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
  const closeAdjust = () => {
    setAdjust(false);
    if (params.has("adjust")) {
      params.delete("adjust");
      setParams(params, { replace: true });
    }
  };

  const render = (id: ReviewSection) => {
    if (!review) return null;
    switch (id) {
      case "budget":
        return <BudgetSection review={review} categories={lookups?.categories} />;
      case "fixed":
        return <FixedFlexibleMonthCard asOf={review.span.start} today={today} inReview />;
      case "jars":
        return <JarsSection review={review} />;
      case "debt":
        return <DebtSection review={review} />;
      case "subs":
        return <SubscriptionsSection review={review} />;
      case "change":
        return <OneChange review={review} categories={lookups?.categories} />;
    }
  };

  return (
    <>
      <ScreenHeader
        title="Your month"
        back="/insights"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdjust(true)}>
            Adjust
          </Button>
        }
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
          {review.how?.word === "Start" ? (
            <Card as="section" aria-label="Nothing this month">
              <Word>Start</Word>
              <p>Nothing logged in {formatMonth(review.span.start)}.</p>
            </Card>
          ) : null}
          <Arranged
            screen="month_review"
            name="Your month"
            cards={REVIEW_SECTIONS}
            render={render}
          />
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
      <MonthReviewAdjust open={adjust} onClose={closeAdjust} prefs={prefs} />
    </>
  );
}
