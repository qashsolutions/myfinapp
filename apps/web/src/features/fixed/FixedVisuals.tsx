import type { FixedFlexible } from "../../engine/bridge.ts";
import { formatCents, formatMonth, formatMonthAbbr } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

/**
 * Fixed vs flexible pictures (October 29, 2026; owner: "make it visual"). Shapes are display
 * arithmetic on the engine's own amounts and rates; nothing here computes money.
 */

/** "11%" for a kept rate in bps, "–" when there was no money in. */
export function ratePct(bps: number | null): string {
  return bps === null ? "–" : `${Math.round(bps / 100)}%`;
}

/** The month's out split three ways: fixed, flexible needs and the rest, flexible wants (room). */
export function donutParts(
  result: FixedFlexible,
): Array<[kind: string, label: string, cents: number]> {
  const wants = Math.max(result.flexible_by_bucket.want, 0);
  return [
    ["fixed", "Fixed", Math.max(result.fixed_cents, 0)],
    ["flex", "Flexible", Math.max(result.flexible_cents - wants, 0)],
    ["room", "Wants (room)", wants],
  ];
}

const SIZE = 148;
const STROKE = 18;

/**
 * The month as a ring: fixed, flexible, flexible wants. The kept rate sits in the middle as the
 * hero, its unit small; the key beside it carries each amount, so the picture reads without help.
 */
export function FixedDonut({ result, label }: { result: FixedFlexible; label: string }) {
  const parts = donutParts(result);
  const total = parts.reduce((sum, [, , c]) => sum + c, 0);
  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const rate = result.kept_rate_bps;
  const said = parts.map(([, name, cents]) => `${name} ${formatCents(cents)}`).join(", ");
  return (
    <div className="fixed-donut">
      <div className="fixed-donut__ring">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${label}: ${rate === null ? "no money in" : `${ratePct(rate)} kept`}. ${said}.`}
        >
          <circle
            className="fixed-donut__track"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={r}
            fill="none"
            strokeWidth={STROKE}
          />
          {total > 0
            ? parts.map(([kind, , cents]) => {
                const len = (cents / total) * circumference;
                const seg = (
                  <circle
                    key={kind}
                    className={`fixed-donut__seg fixed-donut__seg--${kind}`}
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={r}
                    fill="none"
                    strokeWidth={STROKE}
                    strokeDasharray={`${len} ${circumference - len}`}
                    strokeDashoffset={-offset}
                    transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                  />
                );
                offset += len;
                return cents > 0 ? seg : null;
              })
            : null}
        </svg>
        <span className="fixed-donut__center" aria-hidden="true">
          {rate === null ? (
            <span className="fixed-donut__value fixed-donut__value--small">
              {formatCents(Math.abs(result.kept_cents))}
            </span>
          ) : (
            <span className="fixed-donut__value">{ratePct(rate)}</span>
          )}
          <span className="fixed-donut__unit">
            {result.kept_cents < 0 && rate === null ? "over" : "kept"}
          </span>
        </span>
      </div>
      <dl className="fixed-donut__key">
        {parts.map(([kind, name, cents]) => (
          <div key={kind} className={`fixed-donut__row fixed-donut__row--${kind}`}>
            <dt>{name}</dt>
            <dd>{formatCents(cents)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Months before the first with anything in or out are left off: a row of dashes says nothing. */
export function activeMonths<M extends { start: string; result: FixedFlexible }>(
  all: M[],
  highlight: string,
): M[] {
  const first = all.findIndex(
    (m) => m.result.in_cents !== 0 || m.result.out_cents !== 0 || m.start === highlight,
  );
  return first > 0 ? all.slice(first) : all;
}

const TREND_H = 112;
const TOP = 20;
const BOTTOM = 22;

/**
 * Kept rate by month as bars, the month in view drawn full strength and the rest faded; below
 * zero in red. Drawn one unit per pixel so the labels keep their size on a computer.
 */
export function KeptTrend({
  months: all,
  highlight,
}: {
  months: Array<{ start: string; result: FixedFlexible }>;
  /** The month start drawn full strength. */
  highlight: string;
}) {
  const [box, width] = useBoxWidth(320, 200);
  const months = activeMonths(all, highlight);
  const rates = months.map((m) => m.result.kept_rate_bps);
  const maxPos = Math.max(0, ...rates.map((r) => r ?? 0));
  const minNeg = Math.min(0, ...rates.map((r) => r ?? 0));
  const span = Math.max(maxPos - minNeg, 1);
  const plotH = TREND_H - TOP - BOTTOM;
  const zeroY = TOP + (maxPos / span) * plotH;
  const col = width / Math.max(months.length, 1);
  const barW = Math.min(32, col * 0.56);
  const said = months
    .map((m) => `${formatMonth(m.start)} ${ratePct(m.result.kept_rate_bps)}`)
    .join(", ");
  return (
    <div ref={box} className="kept-trend">
      <svg
        width={width}
        height={TREND_H}
        viewBox={`0 0 ${width} ${TREND_H}`}
        role="img"
        aria-label={`Kept rate by month: ${said}`}
      >
        <line className="kept-trend__zero" x1={0} x2={width} y1={zeroY} y2={zeroY} />
        {months.map((m, i) => {
          const bps = m.result.kept_rate_bps;
          const value = bps ?? 0;
          const h = (Math.abs(value) / span) * plotH;
          const x = col * i + (col - barW) / 2;
          const y = value >= 0 ? zeroY - h : zeroY;
          const on = m.start === highlight;
          const tone = value < 0 ? "neg" : "pos";
          const labelY = value > 0 ? y - 5 : zeroY - 5;
          return (
            <g key={m.start}>
              {bps !== null && h > 0 ? (
                <rect
                  className={`kept-trend__bar kept-trend__bar--${tone}${on ? " kept-trend__bar--on" : ""}`}
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(h, 2)}
                  rx={3}
                />
              ) : null}
              <text
                className={`kept-trend__value${on ? " kept-trend__value--on" : ""}`}
                x={x + barW / 2}
                y={labelY}
              >
                {ratePct(bps)}
              </text>
              <text
                className={`kept-trend__month${on ? " kept-trend__month--on" : ""}`}
                x={x + barW / 2}
                y={TREND_H - 6}
              >
                {formatMonthAbbr(m.start)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
