import "../entries/entries.css";
import "./money.css";
import "../ranges/ranges.css";

import { buttonClass, Card, List, ListRow } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Arranged } from "../../app/layout/Arranged.tsx";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { addMonths, monthViewAsOf } from "../../engine/bridge.ts";
import { formatCents, todayIso } from "../../lib/format.ts";
import { useLookups } from "../entries/useEntries.ts";
import { FixedFlexibleMonthCard } from "../fixed/FixedFlexibleCard.tsx";
import { ByAccount } from "../insights/ByAccount.tsx";
import { MoreThanUsual } from "../insights/MoreThanUsual.tsx";
import { RangeBars } from "../ranges/RangeBars.tsx";
import { RangePicker, RangeStepper } from "../ranges/RangePicker.tsx";
import { RANGES, type Range, type RangeChoice, useRange } from "../ranges/ranges.ts";
import "../forecast/forecast.css";
import { useRangeTotals, useSeries } from "../ranges/useSeries.ts";
import { needsSorting } from "../review/review.ts";
import { CategoryBreakdown } from "./CategoryBreakdown.tsx";
import { MoneySummary } from "./MoneySummary.tsx";
import { MonthPicker } from "./MonthPicker.tsx";
import { NextMoney } from "./NextMoney.tsx";
import { RangeMoney } from "./RangeMoney.tsx";
import { TransactionList } from "./TransactionList.tsx";
import { useMonthTotals } from "./useMonthTotals.ts";

/** Money in & out (mockup F3Money): the month view, from Home's summary card and the top of Budget. */
/** The month view's cards; each person arranges their own (October 25, 2026). */
export const MONEY_CARDS = [
  ["summary", "In, out and kept", "The month's totals"],
  ["weeks", "In vs out by week", "A bar per week"],
  ["fixed", "Fixed vs flexible", "Bills against the rest, and what you keep"],
  ["details", "Categories and transactions", "Where it went, entry by entry"],
] as const;
type MoneyCardId = (typeof MONEY_CARDS)[number][0];

export function MoneyScreen() {
  const ids = useId();
  const navigate = useNavigate();
  const { db } = useDb();
  const tagged = useLiveQuery(
    async () => (await db.entries.orderBy("tags").uniqueKeys()).length > 0,
    [db],
  );
  const [asOf, setAsOf] = useState(todayIso());
  // The tab is in the address, so "your entries" links and Back land on Transactions.
  const [params, setParams] = useSearchParams();
  const tab: "categories" | "transactions" =
    params.get("view") === "transactions" ? "transactions" : "categories";
  const setTab = (next: "categories" | "transactions") =>
    setParams(next === "transactions" ? { view: "transactions" } : {}, { replace: true });
  const view = useMonthTotals(asOf);
  // "Don't count" entries stay listed (faded); this shows just them, to find and undo one.
  const notCounted = (view.entries ?? []).filter((e) => e.not_counted);
  const [onlyNotCounted, setOnlyNotCounted] = useState(false);
  const unsorted = (view.entries ?? []).filter(needsSorting).length;
  const lookups = useLookups();
  // Time ranges (October 20, 2026): 1M is the month view below; longer ranges add up months.
  const today = todayIso();
  const {
    range: savedRange,
    setRange: saveRange,
    back,
    setBack,
  } = useRange<RangeChoice>("money", "Month", [...RANGES, "Next"]);
  // A "your entries" link (ENTRIES_PATH) always lands on the month's list: for this visit the
  // Month view and the Categories and transactions card are shown whatever was saved, and the
  // saved range and layout are left alone. Picking a range ends the visit's override.
  const [entriesVisit, setEntriesVisit] = useState(tab === "transactions");
  useEffect(() => {
    if (tab === "transactions") setEntriesVisit(true);
  }, [tab]);
  const range: RangeChoice = entriesVisit ? "Month" : savedRange;
  const setRange = (r: RangeChoice) => {
    setEntriesVisit(false);
    saveRange(r);
  };
  const past: Range = range === "Next" ? "Month" : range;
  const ranged = useRangeTotals(past, today, back);
  const monthEnd = view.bounds ? (view.bounds.end < today ? view.bounds.end : today) : null;
  const weeks = useSeries(view.bounds?.start ?? null, monthEnd, "week");

  async function shift(delta: number) {
    if (!view.bounds) return;
    // Money in & out counts what happened: never a month after this one (Next looks ahead).
    if (delta > 0 && view.bounds.end >= today) return;
    setAsOf(await monthViewAsOf(await addMonths(view.bounds.start, delta), today));
  }

  const transferNote =
    view.totals && view.totals.transfers_out_cents > 0
      ? `transfers excluded (${formatCents(view.totals.transfers_out_cents)})`
      : null;

  const card = (id: MoneyCardId) => {
    switch (id) {
      case "summary":
        return (
          <MoneySummary
            totals={view.totals}
            previous={view.previous}
            delta={view.delta}
            previousStart={view.previous?.start ?? null}
            transferNote={transferNote}
          />
        );
      case "weeks":
        return (
          <>
            {weeks && weeks.count > 0 ? (
              <Card as="section" aria-label="In vs out by week">
                <div className="range-key" aria-hidden="true">
                  <span>In</span>
                  <span>Out</span>
                </div>
                <RangeBars steps={weeks.steps} kind="week" />
              </Card>
            ) : null}
          </>
        );
      case "fixed":
        return <FixedFlexibleMonthCard asOf={asOf} today={today} />;
      case "details":
        return (
          <>
            <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
              <legend className="sr-only">View</legend>
              {(
                [
                  ["categories", "Categories"],
                  ["transactions", "Transactions"],
                ] as const
              ).map(([value, label]) => (
                <label className="segmented__option" key={value}>
                  <input
                    className="segmented__input"
                    type="radio"
                    name={`${ids}-view`}
                    value={value}
                    checked={tab === value}
                    onChange={() => setTab(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {tab === "categories" && view.totals && lookups ? (
              <>
                {asOf === todayIso() ? (
                  <MoreThanUsual asOf={asOf} categories={lookups.categories} />
                ) : null}
                <CategoryBreakdown totals={view.totals} categories={lookups.categories} />
                <ByAccount totals={view.totals} accounts={lookups.accounts} />
                {unsorted > 0 ? (
                  <List card>
                    <ListRow
                      label={`${unsorted} to sort`}
                      sublabel="Pick a category, one at a time"
                      href="/review"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate("/review");
                      }}
                    />
                  </List>
                ) : null}
                {tagged ? (
                  <List card>
                    <ListRow
                      label="Your tags"
                      sublabel="Trips and projects across categories"
                      href="/tags"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate("/tags");
                      }}
                    />
                  </List>
                ) : null}
              </>
            ) : null}
            {tab === "transactions" ? (
              <>
                {notCounted.length > 0 ? (
                  <button
                    type="button"
                    className="chip-option not-counted-filter"
                    aria-pressed={onlyNotCounted}
                    onClick={() => setOnlyNotCounted(!onlyNotCounted)}
                  >
                    Not counted ({notCounted.length})
                  </button>
                ) : null}
                <TransactionList
                  entries={
                    onlyNotCounted && notCounted.length > 0 ? notCounted : (view.entries ?? [])
                  }
                  lookups={lookups}
                />
              </>
            ) : null}
          </>
        );
    }
  };

  return (
    <>
      <ScreenHeader
        title="Money in & out"
        back="/"
        actions={
          <Link to="/import" className={buttonClass({ variant: "secondary", size: "sm" })}>
            Import
          </Link>
        }
      />
      <RangePicker value={range} onChange={setRange} next />
      {range === "Next" ? <NextMoney today={today} /> : null}
      {range !== "Month" && range !== "Next" ? (
        <RangeStepper bounds={ranged.bounds} onBack={setBack} />
      ) : null}
      {range !== "Month" && range !== "Next" && lookups ? (
        <RangeMoney
          view={ranged}
          categories={lookups.categories}
          onOpenMonth={(step) => {
            setAsOf(step.start);
            setRange("Month");
          }}
        />
      ) : null}
      {range === "Month" ? (
        <>
          <MonthPicker
            start={view.bounds?.start ?? null}
            onShift={shift}
            atLatest={!!view.bounds && view.bounds.end >= today}
          />
          <Arranged
            screen="money"
            name="Money in & out"
            cards={MONEY_CARDS}
            render={card}
            force={entriesVisit ? ["details"] : []}
          />
        </>
      ) : null}
      <p className="auth__fineprint">
        Totals come from your entries and statements on this device
        {view.rulesVersion ? ` · rules ${view.rulesVersion}` : ""}.
      </p>
    </>
  );
}
