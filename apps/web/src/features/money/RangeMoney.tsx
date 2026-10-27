import "../ranges/ranges.css";

import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import type { Category } from "../../data/db.ts";
import { roundDiv, type SeriesStep } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { RangeBars } from "../ranges/RangeBars.tsx";
import { monthsTouched, RANGE_NAME } from "../ranges/ranges.ts";
import type { RangeView } from "../ranges/useSeries.ts";
import { CategoryBreakdown } from "./CategoryBreakdown.tsx";

const BEFORE: Record<string, string> = {
  Month: "the month before",
  Quarter: "the 3 months before",
  Year: "the 12 months before",
  YTD: "the same days last year",
};

/**
 * Money in & out over a Quarter, a Year or YTD (or a Month stepped back) (docs/spec.md "Time ranges"): Kept for the range, the
 * average a month, the period before, In vs Out bars, and where it went with each category's
 * average a month. Tapping a month opens it.
 */
export function RangeMoney({
  view,
  categories,
  onOpenMonth,
}: {
  view: RangeView;
  categories: Map<string, Category>;
  onOpenMonth: (step: SeriesStep) => void;
}) {
  const { bounds, series, delta } = view;
  const [averages, setAverages] = useState<Map<string | null, number> | undefined>();
  useEffect(() => {
    if (!series || series.active_months < 2) return setAverages(undefined);
    let alive = true;
    void Promise.all(
      series.by_category.map(
        async (r) => [r.category_id, await roundDiv(r.out_cents, series.active_months)] as const,
      ),
    ).then((pairs) => {
      if (alive) setAverages(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [series]);

  if (!bounds || !series) return <p className="range-note">Adding it up…</p>;
  if (series.count === 0)
    return (
      <Card>
        <p>No entries in {bounds.back === 0 ? RANGE_NAME[bounds.range] : bounds.label} yet.</p>
      </Card>
    );
  const net = series.net_cents;
  const short =
    view.firstDate && view.firstDate > bounds.start
      ? monthsTouched(view.firstDate, bounds.end)
      : null;
  const before =
    bounds.range === "YTD" && bounds.back > 0 ? "the year before" : BEFORE[bounds.range];
  return (
    <>
      <fieldset className="stats">
        <legend className="sr-only">{RANGE_NAME[bounds.range]}</legend>
        <div className="stat">
          <span className="stat__l">In</span>
          <span className="stat__n stat__n--good">{formatCents(series.in_cents, "in")}</span>
        </div>
        <div className="stat">
          <span className="stat__l">Out</span>
          <span className="stat__n stat__n--out">{formatCents(series.out_cents, "out")}</span>
        </div>
        <div className="stat stat--kept">
          <span className="stat__l">Kept</span>
          <span className={`stat__n${net < 0 ? " stat__n--bad" : ""}`}>{formatCents(net)}</span>
        </div>
      </fieldset>
      <p className="compare">
        {series.avg_net_cents !== null ? (
          <>
            About {formatCents(Math.abs(series.avg_net_cents))} a month{" "}
            {series.avg_net_cents >= 0 ? "kept" : "over"}
          </>
        ) : null}
        {delta !== null && before ? (
          <>
            {" · vs "}
            {before}: you kept{" "}
            <strong className={delta >= 0 ? "good" : "bad"}>
              {formatCents(Math.abs(delta))} {delta >= 0 ? "more" : "less"}
            </strong>
          </>
        ) : before ? (
          <> · not enough history yet to compare with {before}</>
        ) : null}
      </p>
      {short !== null ? (
        <p className="range-note" role="note">
          You have {short} {short === 1 ? "month" : "months"} so far, so this starts with your first
          entry.
        </p>
      ) : null}
      <Card as="section" aria-label="In vs out">
        <div className="range-key" aria-hidden="true">
          <span>In</span>
          <span>Out</span>
        </div>
        <RangeBars steps={series.steps} kind={series.step} onPick={onOpenMonth} />
      </Card>
      <h2 className="range-h">Where it went</h2>
      <CategoryBreakdown
        totals={series}
        categories={categories}
        averages={averages}
        empty="Nothing out in this range."
      />
    </>
  );
}
