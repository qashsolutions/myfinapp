import { useMonthTotals } from "../money/useMonthTotals.ts";
import { splitLabel } from "./split.ts";
import "../entries/entries.css";
import "../auth/auth.css";
import "./budget.css";

import { buttonClass, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { addMonths, ratioBps } from "../../engine/bridge.ts";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { cardText } from "../../moments/catalog.ts";
import { useLookups } from "../entries/useEntries.ts";
import { MonthPicker } from "../money/MonthPicker.tsx";
import { useNotificationSettings } from "../notifications/useNotifications.ts";
import { BudgetSetup } from "./BudgetSetup.tsx";
import { useBudgetPace } from "./pace.ts";
import { BUCKET_LABELS, RuleView } from "./RuleView.tsx";
import { monthKey, useBudget } from "./useBudget.ts";
import { ZeroBasedView } from "./ZeroBasedView.tsx";

/** The Budget tab (mockup F5Budget): 50/30/20 or zero-based, switchable, for the month. */
export function BudgetScreen() {
  const [asOf, setAsOf] = useState(todayIso());
  const isCurrentMonth = monthKey(asOf) === monthKey(todayIso());
  const view = useBudget(asOf, isCurrentMonth);
  // "Close" at the person's own "Tell me at" when they set one, the level their alert uses.
  const alertPrefs = useNotificationSettings({ background: true }).data?.prefs;
  const pace = useBudgetPace(view.summary, asOf, alertPrefs?.budget_pace?.threshold ?? null);
  // Last month's totals, for zero-based's "Start from last month" (October 23, 2026).
  const lastMonth = useMonthTotals(asOf).previous;
  const lookups = useLookups();
  const [editing, setEditing] = useState<"pay" | "method" | null>(null);
  const [insight, setInsight] = useState<{
    title: string;
    kind: string | null;
    body: string;
  } | null>(null);

  async function shift(delta: number) {
    if (!view.bounds) return;
    setAsOf(await addMonths(view.bounds.start, delta));
  }

  const summary = view.summary;
  useEffect(() => {
    if (!summary || !lookups) {
      setInsight(null);
      return;
    }
    const overBucket = summary.buckets.find((b) => b.left_cents < 0);
    if (!overBucket || summary.method !== "50_30_20") {
      setInsight(null);
      return;
    }
    let alive = true;
    const top = summary.categories
      .filter((c) => c.bucket === overBucket.bucket)
      .sort((a, b) => b.spent_cents - a.spent_cents)[0];
    void (async () => {
      const share = top ? await ratioBps(top.spent_cents, summary.take_home_cents) : null;
      if (!alive) return;
      const [name] = BUCKET_LABELS[overBucket.bucket];
      const topName = top
        ? (lookups.categories.get(top.category_id)?.name ?? "One category")
        : null;
      setInsight({
        title: `${name} are ${formatCents(-overBucket.left_cents)} over plan`,
        kind: cardText("over_plan", { bucket: name }, `${overBucket.bucket}`),
        body:
          topName && share !== null
            ? `${topName} alone is ${Math.round(share / 100)}% of take-home. That's common. Your split is yours to change, or switch to zero-based.`
            : "Your split is yours to change, or switch to zero-based.",
      });
    })();
    return () => {
      alive = false;
    };
  }, [summary, lookups]);

  const month = view.bounds ? formatMonth(view.bounds.start) : "";
  const inOut = (
    <Link to="/money" className={buttonClass({ variant: "secondary", size: "sm" })}>
      In & out
    </Link>
  );

  if (view.budget === undefined || !view.bounds) {
    return (
      <>
        <ScreenHeader title="Budget" actions={inOut} />
        <p className="sr-only" role="status">
          Loading
        </p>
      </>
    );
  }

  if (view.budget === null || editing) {
    const existing = view.budget
      ? {
          id: view.budget.id,
          method: view.budget.method,
          take_home_cents: view.budget.take_home_cents,
        }
      : null;
    return (
      <>
        <ScreenHeader title="Budget" eyebrow={month} actions={inOut} />
        {!view.budget && !isCurrentMonth ? (
          <Card>
            <p>No budget for {month} yet. Budgets are set up from the current month.</p>
          </Card>
        ) : (
          <BudgetSetup
            month={monthKey(asOf)}
            step={editing ?? "pay"}
            existing={existing}
            onDone={() => setEditing(null)}
            onCancel={view.budget ? () => setEditing(null) : undefined}
          />
        )}
        {!view.budget && !isCurrentMonth ? (
          <MonthPicker start={view.bounds.start} onShift={shift} />
        ) : null}
      </>
    );
  }

  const budget = view.budget;
  const styleName = budget.method === "50_30_20" ? splitLabel(budget.split_bps) : "Zero-based";
  return (
    <>
      <ScreenHeader
        title="Budget"
        eyebrow={`${month} · ${formatCents(budget.take_home_cents)} take-home · ${styleName}`}
        actions={inOut}
      />
      <MonthPicker start={view.bounds.start} onShift={shift} />
      {summary && lookups ? (
        budget.method === "50_30_20" ? (
          <RuleView
            summary={summary}
            categories={lookups.categories}
            split={budget.split_bps ?? null}
            pace={pace}
          />
        ) : (
          <ZeroBasedView
            summary={summary}
            lines={view.lines}
            categories={lookups.categories}
            lastMonth={lastMonth}
            pace={pace}
          />
        )
      ) : null}
      {insight ? (
        <Card as="section" className="insight" aria-label={insight.title}>
          <h2 className="sk-card__title">{insight.title}</h2>
          {insight.kind ? <p className="insight__kind">{insight.kind}</p> : null}
          <p>{insight.body}</p>
          {/* Category facts live on Money in & out (October 23, 2026); this card is about the plan. */}
          <Link to="/money">See where it went</Link>
          <button type="button" onClick={() => setEditing("method")}>
            Change budget style
          </button>
        </Card>
      ) : null}
      <div className="transfer-choice">
        <button
          type="button"
          className={buttonClass({ variant: "secondary" })}
          onClick={() => setEditing("pay")}
        >
          Edit take-home
        </button>
        <button
          type="button"
          className={buttonClass({ variant: "secondary" })}
          onClick={() => setEditing("method")}
        >
          Change budget style
        </button>
      </div>
      {summary && summary.uncategorized_cents !== 0 ? (
        <p className="auth__hint">
          {formatCents(summary.uncategorized_cents)} spent without a category isn't in any bucket
          yet.
        </p>
      ) : null}
    </>
  );
}
