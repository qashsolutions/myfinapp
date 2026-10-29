import { formatCents, formatMonthShort } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

/**
 * Your month's small pictures (October 29, 2026; owner: "make it visual"). Shapes only: every
 * amount and date comes from the engine through the review's hooks.
 */

export interface BarRow {
  label: string;
  /** What the bar's length is relative to the longest row (cents, months). */
  size: number;
  /** The value written at the end of the row. */
  text: string;
  tone: "now" | "after" | "in" | "out";
}

/** Rows of bars side by side: before and after, a month against a year, spent against paid. */
export function BeforeAfterBars({ rows, label }: { rows: BarRow[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.size));
  return (
    <ul className="review-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.label} className="review-bars__row">
          <span className="review-bars__label">{r.label}</span>
          <span className="review-bars__track" aria-hidden="true">
            <span
              className={`review-bars__fill review-bars__fill--${r.tone}`}
              style={{ width: `${Math.max(3, (Math.max(r.size, 0) / max) * 100)}%` }}
            />
          </span>
          <span className="review-bars__value">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

const LINE_H = 76;

/**
 * The debt balance on today's plan, month by month down to zero: the balance after this month at
 * the left, the debt-free month at the right. `series` is the plan's own balance after each month.
 */
export function DebtLine({ series, endMonth }: { series: number[]; endMonth: string }) {
  const [box, width] = useBoxWidth(320, 200);
  const points = series;
  const max = Math.max(1, ...points);
  const top = 22;
  const bottom = LINE_H - 8;
  const xs = (i: number) => 4 + (i / Math.max(points.length - 1, 1)) * (width - 8);
  const ys = (c: number) => top + (1 - c / max) * (bottom - top);
  const path = points.map((c, i) => `${xs(i).toFixed(1)},${ys(c).toFixed(1)}`).join(" ");
  return (
    <div ref={box} className="review-line">
      <svg
        width={width}
        height={LINE_H}
        viewBox={`0 0 ${width} ${LINE_H}`}
        role="img"
        aria-label={`Debt balance going down to nothing by ${formatMonthShort(endMonth)}`}
      >
        <line className="review-line__base" x1={0} x2={width} y1={bottom} y2={bottom} />
        <polyline className="review-line__path" points={path} fill="none" />
        <text className="review-line__label" x={4} y={14}>
          {formatCents(points[0] ?? 0)} next month
        </text>
        <text className="review-line__label review-line__label--end" x={width - 4} y={bottom - 6}>
          {formatMonthShort(endMonth)}
        </text>
      </svg>
    </div>
  );
}

/** A count in a round chip with what it counts beside it: "2 · to check". */
export function CountChip({ count, label }: { count: number; label: string }) {
  return (
    <p className="review-count">
      <span className="review-count__n">{count}</span>
      <span>{label}</span>
    </p>
  );
}
