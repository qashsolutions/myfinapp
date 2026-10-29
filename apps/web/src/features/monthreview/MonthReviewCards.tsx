import { Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { MonthTotals } from "../../engine/bridge.ts";
import { formatCents, formatMonth } from "../../lib/format.ts";
import { InOutBars, InsightCard } from "../insights/InsightCard.tsx";
import { useMonthTotals } from "../money/useMonthTotals.ts";
import { dayOfMonth, doneKey, MONTH_REVIEW_PATH, SHOW_DAYS } from "./monthReview.ts";
import { type MonthSpan, useMonthSpan } from "./useMonthReview.ts";

/** "October 2026: $420 kept" for the month reviewed. */
export function monthLine(span: MonthSpan, totals: MonthTotals): string {
  const net = totals.net_cents;
  return `${formatMonth(span.start)}: ${formatCents(Math.abs(net))} ${net < 0 ? "over" : "kept"}`;
}

/** The month's totals from Money in & out's own hook; nothing until `span` is known. */
function useLastMonthTotals(span: MonthSpan | null, today: string) {
  const month = useMonthTotals(span?.end ?? today);
  const ready = span !== null && month.bounds?.start === span.start;
  return {
    totals: ready ? month.totals : null,
    hasEntries: ready && (month.entries?.length ?? 0) > 0,
    loading: !ready || month.entries === undefined,
  };
}

function HomeCardFor({ span }: { span: MonthSpan }) {
  const { db } = useDb();
  const done = useLiveQuery(
    async () => Boolean((await db.settings.get(doneKey(span.month)))?.value),
    [db, span.month],
  );
  const { totals, hasEntries } = useLastMonthTotals(span, span.end);
  if (done !== false || !hasEntries || !totals) return null;
  return (
    <Link
      to={MONTH_REVIEW_PATH}
      className="card-link"
      aria-label={`Your month: ${monthLine(span, totals)}, open the review`}
    >
      <Card as="section" aria-labelledby="home-month-review">
        <h2 className="sk-card__title" id="home-month-review">
          Your month
        </h2>
        <Word>{totals.net_cents < 0 ? "Over" : "Kept"}</Word>
        <p className="sk-card__eyebrow">{monthLine(span, totals)}</p>
        <InOutBars inCents={totals.in_cents} outCents={totals.out_cents} />
      </Card>
    </Link>
  );
}

/**
 * Home's card (HOME_CARDS "month_review"; October 28, 2026, proposed): during the first
 * `month_review.show_days` days of a month, for the month just ended once it has entries, until
 * the person taps Done on the review.
 */
export function MonthReviewHomeCard({ today }: { today: string }) {
  const span = useMonthSpan(null, today);
  if (!span || dayOfMonth(today) > SHOW_DAYS) return null;
  return <HomeCardFor span={span} />;
}

/** The Insights card (INSIGHT_CARDS "month_review"): the month just ended, always there. */
export function MonthReviewInsight({ today }: { today: string }) {
  const span = useMonthSpan(null, today);
  const { totals, hasEntries } = useLastMonthTotals(span, today);
  const ready = span && hasEntries && totals ? { span, totals } : null;
  return (
    <InsightCard
      title="Your month"
      to={MONTH_REVIEW_PATH}
      word={ready ? (ready.totals.net_cents < 0 ? "Over" : "Kept") : "Start"}
      line={ready ? monthLine(ready.span, ready.totals) : "Ready after a month of entries"}
    >
      {ready ? (
        <InOutBars inCents={ready.totals.in_cents} outCents={ready.totals.out_cents} />
      ) : null}
    </InsightCard>
  );
}
