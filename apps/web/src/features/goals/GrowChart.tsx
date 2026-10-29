import type { GrowReach } from "../../engine/bridge.ts";
import { formatCents, formatMonth, formatMonthShort } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";
import { shortMoney } from "../later/LaterChart.tsx";

const DESIGN_W = 354;
const LEFT = 6;
const RIGHT = 6;
const TOP = 22;
const BOTTOM = 10;
/** Two labels closer than this (in pixels, one SVG unit each) would touch: one is left out. */
const NEAR = 16;

/** Whole dollars under $10,000 ("$2,050"), so close amounts never both read "$2k"; else $12k. */
function chartMoney(cents: number): string {
  return cents < 1_000_000 ? formatCents(cents).replace(/\.\d\d$/, "") : shortMoney(cents);
}

/**
 * A goal that grows, as a picture (October 29, 2026): the cost rising from today to the date
 * (dashed) and the savings at the chosen monthly amount (the line), both from
 * `growth.goal_reach`'s points, with today's cost, what's saved so far (the dot) and both
 * ends' amounts labelled. Drawn one unit per pixel so labels keep their size.
 */
export function GrowChart({
  reach,
  monthly,
  compact = false,
}: {
  reach: GrowReach;
  /** The monthly amount the savings line uses, for the text alternative. */
  monthly: number;
  compact?: boolean;
}) {
  const [box, W] = useBoxWidth(DESIGN_W);
  const pts = reach.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < 2) return null;
  const H = compact ? 130 : 170;
  const n = Math.max(1, last.months);
  const top = Math.max(1, ...pts.map((p) => Math.max(p.cost_cents, p.saved_cents)));
  const x = (k: number) => LEFT + (k / n) * (W - LEFT - RIGHT);
  const y = (v: number) => TOP + (1 - v / top) * (H - TOP - BOTTOM);
  const line = (f: (p: (typeof pts)[number]) => number) =>
    pts.map((p) => `${x(p.months).toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");
  const costEnd = y(last.cost_cents);
  const savedEnd = y(last.saved_cents);
  const ends = Math.abs(costEnd - savedEnd) >= NEAR;
  const savedNow = first.saved_cents;
  const startApart = Math.abs(y(first.cost_cents) - y(savedNow)) >= NEAR;
  const when = formatMonth(`${last.month}-01`);
  const label =
    `Cost rising from ${formatCents(first.cost_cents)} today to ${formatCents(last.cost_cents)} by ${when}. ` +
    `Saving ${formatCents(monthly)} a month${savedNow > 0 ? ` on top of ${formatCents(savedNow)} saved now` : ""} comes to ${formatCents(last.saved_cents)} by then.`;
  return (
    <>
      <div ref={box} className="chart-box">
        <svg className="grow__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          <line x1={LEFT} y1={H - BOTTOM} x2={W - RIGHT} y2={H - BOTTOM} stroke="var(--c-line)" />
          <polyline
            points={line((p) => p.cost_cents)}
            fill="none"
            stroke="var(--c-ink)"
            strokeWidth="2"
            strokeDasharray="6 4"
          />
          <polyline
            points={line((p) => p.saved_cents)}
            fill="none"
            stroke="var(--c-a1)"
            strokeWidth="3.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <text x={LEFT} y={Math.max(12, y(first.cost_cents) - 6)} className="grow__label">
            {chartMoney(first.cost_cents)} today
          </text>
          {savedNow > 0 ? (
            <>
              <circle cx={x(0)} cy={y(savedNow)} r="5" fill="var(--c-a1)" />
              {startApart ? (
                <text
                  x={LEFT + 10}
                  y={Math.min(H - BOTTOM - 4, y(savedNow) + 4)}
                  className="grow__label grow__label--start"
                >
                  Saved {chartMoney(savedNow)}
                </text>
              ) : null}
            </>
          ) : null}
          <circle cx={x(n)} cy={savedEnd} r="5" fill="var(--c-a1)" />
          {ends ? (
            <>
              {/* The higher end is labelled above its point, the lower one below its own. */}
              <text
                x={W - RIGHT}
                y={Math.max(12, Math.min(costEnd, savedEnd) - 8)}
                className={`grow__label grow__label--end${savedEnd < costEnd ? " grow__label--saved" : ""}`}
              >
                {chartMoney(savedEnd < costEnd ? last.saved_cents : last.cost_cents)}
              </text>
              <text
                x={W - RIGHT - 10}
                y={Math.min(H - BOTTOM - 4, Math.max(costEnd, savedEnd) + 16)}
                className={`grow__label grow__label--end${savedEnd > costEnd ? " grow__label--saved" : ""}`}
              >
                {chartMoney(savedEnd > costEnd ? last.saved_cents : last.cost_cents)}
              </text>
            </>
          ) : (
            <text
              x={W - RIGHT}
              y={Math.max(12, Math.min(costEnd, savedEnd) - 8)}
              className="grow__label grow__label--end"
            >
              {chartMoney(Math.max(last.cost_cents, last.saved_cents))}
            </text>
          )}
        </svg>
      </div>
      <div className="forecast__axis" aria-hidden="true">
        <span>Today</span>
        <span>{formatMonthShort(last.month)}</span>
      </div>
      <div className="forecast__legend" aria-hidden="true">
        <span>
          <i className="forecast__key grow__key--cost" /> Cost
        </span>
        <span>
          <i className="forecast__key grow__key--saved" /> Your savings
        </span>
      </div>
    </>
  );
}
