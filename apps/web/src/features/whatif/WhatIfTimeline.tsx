import { formatMonthShort } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

const DESIGN_W = 354;
const BAR = 14;

export interface TimelineRow {
  /** "Now" or "With $100 more". */
  label: string;
  /** Months from today to the finish; null = no finish (never at this pace). */
  months: number | null;
  /** The finish month, YYYY-MM. */
  end: string | null;
  /** A short amount beside the date, e.g. "$6.14 interest". */
  note?: string;
}

/**
 * What if's before / after picture (October 29, 2026): two bars from today to the finish month,
 * now and with the change, the months saved highlighted on the second, the dates at the ends.
 * A side that never finishes runs the full width and says so. Drawn one unit per pixel.
 */
export function WhatIfTimeline({
  before,
  after,
  what,
}: {
  before: TimelineRow;
  after: TimelineRow;
  /** What finishes, for the text alternative ("Card paid off", "Lisbon jar done"). */
  what: string;
}) {
  const [box, W] = useBoxWidth(DESIGN_W);
  const known = [before.months, after.months].filter((m): m is number => m !== null);
  const longest = Math.max(1, ...known);
  // A side with no finish runs past the longest known one, so it reads as "longer than any".
  const span = known.length === 2 ? longest : Math.ceil(longest * 1.25) + 1;
  const x = (m: number | null) => (m === null ? W : Math.max(4, (m / span) * W));
  const saved: [number, number] | null =
    before.months !== null && after.months !== null && after.months < before.months
      ? [x(after.months), x(before.months)]
      : before.months === null && after.months !== null
        ? [x(after.months), W]
        : null;
  const endText = (r: TimelineRow) =>
    `${r.end ? formatMonthShort(r.end) : "No date"}${r.note ? ` · ${r.note}` : ""}`;
  const said = (r: TimelineRow) =>
    `${r.label}: ${r.end ? `${what} by ${formatMonthShort(r.end)}` : "no date at this pace"}${r.note ? `, ${r.note}` : ""}.`;
  return (
    <div className="whatif-tl" role="img" aria-label={`${said(before)} ${said(after)}`}>
      <div ref={box} className="chart-box" aria-hidden="true">
        {[before, after].map((r, i) => (
          <div className="whatif-tl__row" key={r.label}>
            <div className="whatif-tl__head">
              <span>{r.label}</span>
              <strong>{endText(r)}</strong>
            </div>
            <svg
              viewBox={`0 0 ${W} ${BAR}`}
              width={W}
              height={BAR}
              className="whatif-tl__bar"
              aria-hidden="true"
            >
              <rect x="0" y="0" width={W} height={BAR} rx={BAR / 2} fill="var(--c-line)" />
              {i === 1 && saved ? (
                <rect
                  x={saved[0]}
                  y="0"
                  width={Math.max(0, saved[1] - saved[0])}
                  height={BAR}
                  fill="var(--c-success)"
                  opacity="0.45"
                />
              ) : null}
              <rect
                x="0"
                y="0"
                width={x(r.months)}
                height={BAR}
                rx={BAR / 2}
                fill={i === 0 ? "var(--c-sub)" : "var(--c-a1)"}
                opacity={r.months === null ? 0.5 : 1}
              />
            </svg>
          </div>
        ))}
        <div className="forecast__axis">
          <span>Today</span>
          {saved ? (
            <span className="whatif-tl__key">
              <i className="forecast__key whatif-tl__key--saved" /> Months saved
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
