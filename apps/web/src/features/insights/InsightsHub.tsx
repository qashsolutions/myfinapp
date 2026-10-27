import "./insights.css";

import "../ranges/ranges.css";
import { Chip } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Arranged } from "../../app/layout/Arranged.tsx";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { ratioBps } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { useBudget } from "../budget/useBudget.ts";
import { useForecast } from "../forecast/useForecast.ts";
import { useRecurringSeries } from "../forecast/useRecurring.ts";
import { useGoals } from "../goals/useGoals.ts";
import { LaterChart, shortMoney } from "../later/LaterChart.tsx";
import { laterStatus, useLaterProjection } from "../later/LaterScreen.tsx";
import { useLaterPlan } from "../later/useLaterPlan.ts";
import { useMonthTotals } from "../money/useMonthTotals.ts";
import { WorthBars } from "../networth/NetWorthScreen.tsx";
import { useNetWorth } from "../networth/useNetWorth.ts";
import { RangeBars } from "../ranges/RangeBars.tsx";
import { useRangeTotals } from "../ranges/useSeries.ts";
import { BalanceRunway, BucketBars, InOutBars, InsightCard, Ring } from "./InsightCard.tsx";
import { useSafeToSpend } from "./useSafeToSpend.ts";
import { useTopSpending } from "./useTopSpending.ts";

/**
/**
 * Insights (owner decision, October 18, 2026; replaces Learn's articles): one card per area, each
 * one word of value, a short line and a small picture (October 25, 2026); tapping opens the
 * detail. Every number comes from the same engine calls the detail screens use. The cards are in
 * the person's own order (`Arranged`).
 */
export const INSIGHT_CARDS = [
  ["money", "Money in & out", "This month in and out"],
  ["sorted", "Auto-sorted spending", "How much is sorted"],
  ["spending", "Biggest & most often", "Top amounts and merchants"],
  ["bills", "Bills & subscriptions", "What's coming up"],
  ["safe", "Safe to spend", "Room before payday"],
  ["budget", "Budget & jars", "Your plan and jars"],
  ["worth", "Net worth", "Own minus owe"],
  ["later", "Later", "Savings by the age you choose"],
] as const;
type InsightId = (typeof INSIGHT_CARDS)[number][0];

export function InsightsHub() {
  const asOf = todayIso();
  const month = useMonthTotals(asOf);
  const forecast = useForecast(asOf);
  const safe = useSafeToSpend(forecast, asOf);
  const budget = useBudget(asOf, false);
  const bills = useRecurringSeries("confirmed");
  const [laterPlan] = useLaterPlan();
  const later = useLaterProjection(laterPlan);
  const goals = useGoals();
  const worth = useNetWorth(asOf);
  // Home already says this month; this card shows the months behind it (October 23, 2026), once
  // there are at least two with entries.
  const sixMonths = useRangeTotals("Year", asOf).series;
  const trend = sixMonths && sixMonths.active_months >= 2 ? sixMonths : null;
  const often = useTopSpending("Month", asOf, 3).result;
  const topMerchant = often?.merchants[0];

  // Share of this month's entries sorted into a category (transfers aren't spending).
  const spending = (month.entries ?? []).filter((e) => !e.is_transfer && !e.not_counted);
  const unsorted = spending.filter((e) => e.category_id === null).length;
  const [sortedBps, setSortedBps] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    if (spending.length === 0) {
      setSortedBps(null);
      return;
    }
    void ratioBps(spending.length - unsorted, spending.length).then((bps) => {
      if (alive) setSortedBps(bps);
    });
    return () => {
      alive = false;
    };
  }, [spending.length, unsorted]);

  const totals = month.totals;
  const upcomingBills = (bills ?? []).filter((s) => s.kind === "bill");
  const summary = budget.summary;
  const jars = (goals ?? []).filter((g) => g.kind === "save" && g.group_id === null);
  const reachedJars = jars.filter((g) => g.status === "reached").length;

  const card = (id: InsightId) => {
    switch (id) {
      case "money":
        return (
          <InsightCard
            title="Money in & out"
            to="/money"
            word={
              trend
                ? (trend.avg_net_cents ?? 0) < 0
                  ? "Over"
                  : "Kept"
                : totals
                  ? totals.net_cents < 0
                    ? "Over"
                    : "Kept"
                  : "Start"
            }
            line={
              trend ? (
                <span className={(trend.avg_net_cents ?? 0) < 0 ? "insight-neg" : undefined}>
                  About {formatCents(Math.abs(trend.avg_net_cents ?? 0))} a month{" "}
                  {(trend.avg_net_cents ?? 0) < 0 ? "over" : "kept"}
                </span>
              ) : totals ? (
                <span className={totals.net_cents < 0 ? "insight-neg" : undefined}>
                  {formatCents(totals.net_cents)} kept
                </span>
              ) : (
                "Nothing yet this month"
              )
            }
          >
            {trend ? (
              <>
                <span className="range-key" aria-hidden="true">
                  <span>In</span>
                  <span>Out</span>
                </span>
                <RangeBars steps={trend.steps} kind="month" />
              </>
            ) : totals ? (
              <>
                <InOutBars inCents={totals.in_cents} outCents={totals.out_cents} />
                <span className="inout__legend">
                  <span>In {formatCents(totals.in_cents)}</span>
                  <span>Out {formatCents(totals.out_cents)}</span>
                </span>
              </>
            ) : null}
          </InsightCard>
        );
      case "sorted":
        return (
          <InsightCard
            title="Auto-sorted spending"
            to={unsorted > 0 ? "/review" : "/money"}
            word={sortedBps === null ? "Start" : unsorted > 0 ? "Review" : "Sorted"}
            line={
              sortedBps === null
                ? "Ready when you add spending"
                : `${Math.round(sortedBps / 100)}% sorted`
            }
            tag={unsorted > 0 ? <Chip tone="pending">{unsorted} to review</Chip> : null}
          >
            {sortedBps !== null ? <Ring pct={sortedBps / 100} /> : null}
          </InsightCard>
        );
      case "spending":
        return (
          <InsightCard
            title="Biggest & most often"
            to="/insights/spending"
            word={topMerchant ? "Top" : "None"}
            line={
              topMerchant
                ? `${topMerchant.name}, ${topMerchant.count} ${topMerchant.count === 1 ? "time" : "times"}`
                : "Nothing out yet this month"
            }
          >
            {often && often.merchants.length > 0 ? (
              <ul className="top-merchants" aria-hidden="true">
                {often.merchants.map((m) => (
                  <li key={m.key}>
                    <strong>{m.name}</strong>
                    <span>
                      {m.count}× · {formatCents(m.total_cents)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </InsightCard>
        );
      case "bills":
        return (
          <InsightCard
            title="Bills & subscriptions"
            to="/bills"
            word={upcomingBills.length > 0 ? "Upcoming" : "None"}
            line={
              upcomingBills.length === 0
                ? "No bills tracked yet"
                : `${upcomingBills.length} regular ${upcomingBills.length === 1 ? "bill" : "bills"}`
            }
          >
            {upcomingBills.length > 0 ? (
              <ul className="bill-chips" aria-hidden="true">
                {upcomingBills.slice(0, 3).map((b) => (
                  <li key={b.id} className="bill-chips__item">
                    <span className="bill-chips__date">{formatDay(b.next_date)}</span>
                    <span className="bill-chips__name">{b.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </InsightCard>
        );
      case "safe":
        return (
          <InsightCard
            title="Safe to spend"
            to="/forecast"
            word={
              forecast.needsBalance
                ? "Start"
                : !safe
                  ? "Soon"
                  : safe.safe_cents > 0
                    ? "Room"
                    : "Tight"
            }
            line={
              forecast.needsBalance
                ? "Add your balance"
                : !safe
                  ? "Working it out"
                  : safe.safe_cents > 0
                    ? `${formatCents(safe.per_day_cents)} a day${safe.payday ? ` until ${formatDay(safe.payday)}` : ""}`
                    : safe.payday
                      ? "Nothing spare before payday"
                      : "Nothing spare in the next 30 days"
            }
            tag={forecast.projection?.shortfall ? <Chip tone="warning">Dips low</Chip> : null}
          >
            {forecast.projection && safe ? (
              <BalanceRunway
                days={forecast.projection.days.filter(
                  (d) => d.date >= asOf && d.date <= safe.until,
                )}
                cushionCents={forecast.bufferCents}
                endLabel={safe.payday ? `Payday ${formatDay(safe.payday)}` : formatDay(safe.until)}
              />
            ) : null}
          </InsightCard>
        );
      case "budget":
        return (
          <InsightCard
            title="Budget & jars"
            to="/budget"
            word={
              !summary
                ? "Start"
                : summary.total_spent_cents > summary.take_home_cents ||
                    summary.buckets.some((b) => b.spent_cents > b.planned_cents)
                  ? "Over"
                  : "Steady"
            }
            line={
              !summary
                ? "Set your budget"
                : summary.left_to_assign_cents !== null && summary.left_to_assign_cents !== 0
                  ? `${formatCents(summary.left_to_assign_cents)} to assign`
                  : `${formatCents(summary.total_spent_cents)} of ${formatCents(summary.take_home_cents)}`
            }
            tag={
              jars.length > 0 ? (
                <Chip tone="neutral">
                  {jars.length} {jars.length === 1 ? "jar" : "jars"}
                  {reachedJars > 0 ? ` · ${reachedJars} reached` : ""}
                </Chip>
              ) : null
            }
          >
            {summary && summary.method !== "zero_based" ? (
              <BucketBars buckets={summary.buckets} />
            ) : null}
          </InsightCard>
        );
      case "worth":
        return (
          <InsightCard
            title="Net worth"
            to="/net-worth"
            word={
              !worth.summary || !worth.rows.some((r) => r.included && r.valueCents !== null)
                ? "Start"
                : (worth.summary.change_cents ?? 0) > 0
                  ? "Up"
                  : (worth.summary.change_cents ?? 0) < 0
                    ? "Down"
                    : "Steady"
            }
            line={
              worth.summary && worth.rows.some((r) => r.included && r.valueCents !== null)
                ? `${formatCents(worth.summary.net_cents)}${worth.summary.change_cents ? `, ${worth.summary.change_cents > 0 ? "up" : "down"} ${formatCents(Math.abs(worth.summary.change_cents))} since last month` : ""}`
                : "See what you own minus what you owe"
            }
          >
            {worth.summary && (worth.summary.assets_cents > 0 || worth.summary.debts_cents > 0) ? (
              <WorthBars assets={worth.summary.assets_cents} debts={worth.summary.debts_cents} />
            ) : null}
          </InsightCard>
        );
      case "later":
        return (
          <InsightCard
            title="Later"
            to="/insights/later"
            word={later && laterPlan ? laterStatus(laterPlan, later).word : "Start"}
            line={
              later && laterPlan
                ? `${shortMoney(later.at_retirement_cents[later.middle_index] ?? 0)} at ${laterPlan.retire_age}`
                : "Your savings later"
            }
          >
            {later ? <LaterChart p={later} /> : null}
          </InsightCard>
        );
    }
  };

  return (
    <>
      <ScreenHeader title="Insights" actions={null} />
      <div className="insight-grid">
        <Arranged screen="insights" name="Insights" cards={INSIGHT_CARDS} render={card} />
      </div>
    </>
  );
}
