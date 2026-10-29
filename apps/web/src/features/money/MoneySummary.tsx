import type { MonthTotals } from "../../engine/bridge.ts";
import { formatCents, formatMonth } from "../../lib/format.ts";

/** In · Out · Kept, and the line under them (mockup F3Money). */
export function MoneySummary({
  totals,
  previous,
  delta,
  previousStart,
  previousPartial = false,
  transferNote,
}: {
  totals: MonthTotals | null;
  previous: MonthTotals | null;
  delta: number | null;
  previousStart: string | null;
  /** The month before is only partly here (invariant 51): said plainly, never compared. */
  previousPartial?: boolean;
  transferNote: string | null;
}) {
  const net = totals?.net_cents ?? 0;
  return (
    <>
      <fieldset className="stats">
        <legend className="sr-only">This month</legend>
        <div className="stat">
          <span className="stat__l">In</span>
          <span className="stat__n stat__n--good">{formatCents(totals?.in_cents ?? 0, "in")}</span>
        </div>
        <div className="stat">
          <span className="stat__l">Out</span>
          <span className="stat__n stat__n--out">{formatCents(totals?.out_cents ?? 0, "out")}</span>
        </div>
        <div className="stat stat--kept">
          <span className="stat__l">Kept</span>
          <span className={`stat__n${net < 0 ? " stat__n--bad" : ""}`}>{formatCents(net)}</span>
        </div>
      </fieldset>
      <p className="compare">
        {previous && previousStart && previous.count > 0 && delta !== null ? (
          <>
            vs {formatMonth(previousStart).split(" ")[0]}: you kept{" "}
            <strong className={delta >= 0 ? "good" : "bad"}>
              {formatCents(Math.abs(delta))} {delta >= 0 ? "more" : "less"}
            </strong>
          </>
        ) : previousPartial ? (
          <>First full month here, nothing to compare yet</>
        ) : previousStart ? (
          <>No entries in {formatMonth(previousStart).split(" ")[0]} to compare</>
        ) : null}
        {transferNote ? ` · ${transferNote}` : ""}
      </p>
    </>
  );
}
