import type { PayoffPlan } from "../../engine/bridge.ts";
import { formatCents, formatMonthShort } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";
import { shortMoney } from "../later/LaterChart.tsx";

const H = 170;
const TOP = 30;
const BOTTOM = 8;
const SIDE = 12;
const MARK_R = 10;

/** The total balance at month i of a plan: the start at 0, then `series_cents[i - 1]`. */
function valueAt(plan: PayoffPlan, start: number, i: number): number {
  if (i <= 0) return start;
  return plan.series_cents[i - 1] ?? 0;
}

function monthsOf(plan: PayoffPlan): number {
  return plan.series_cents.length;
}

/**
 * The payoff timeline (October 29, 2026): the total balance falling to zero month by month
 * from `bills.payoff_plan`'s balance after each month, each debt's payoff month marked with its
 * place in the order (the legend names it), and the debt-free month at the end. `other` is the
 * other order, drawn dashed behind so the two can be compared by eye. One SVG unit per pixel.
 */
export function PayoffChart({
  plan,
  other,
  startCents,
  otherLabel,
}: {
  plan: PayoffPlan;
  other?: PayoffPlan | null;
  startCents: number;
  otherLabel?: string;
}) {
  const [box, W] = useBoxWidth(320);
  const n = monthsOf(plan);
  if (plan.stalled || n < 1 || startCents <= 0) return null;
  // The other order is drawn only when it differs (it often ends the same month).
  const showOther =
    other &&
    !other.stalled &&
    monthsOf(other) > 0 &&
    other.series_cents.some((v, i) => v !== plan.series_cents[i])
      ? other
      : null;
  const span = Math.max(n, showOther ? monthsOf(showOther) : 0, 1);
  const x = (i: number) => SIDE + (i / span) * (W - 2 * SIDE);
  const y = (v: number) => TOP + (1 - v / startCents) * (H - TOP - BOTTOM);
  const line = (p: PayoffPlan) =>
    Array.from(
      { length: monthsOf(p) + 1 },
      (_, i) => `${x(i).toFixed(1)},${y(valueAt(p, startCents, i)).toFixed(1)}`,
    ).join(" ");
  // Each debt's payoff marker; markers that would touch are lifted onto a row above.
  const placed: Array<{ id: string; rank: number; cx: number; cy: number }> = [];
  const ordered = plan.order
    .filter((d) => d.months !== null && d.months > 0)
    .sort((a, b) => (a.months ?? 0) - (b.months ?? 0) || a.rank - b.rank);
  for (const d of ordered) {
    const cx = x(d.months ?? 0);
    let cy = y(valueAt(plan, startCents, d.months ?? 0)) - MARK_R - 4;
    for (const p of placed) {
      if (Math.abs(p.cx - cx) < MARK_R * 2 + 2 && Math.abs(p.cy - cy) < MARK_R * 2 + 2) {
        cy = p.cy - MARK_R * 2 - 2;
      }
    }
    placed.push({ id: d.id, rank: d.rank, cx, cy: Math.max(MARK_R, cy) });
  }
  const end = plan.debt_free_month ? formatMonthShort(plan.debt_free_month) : null;
  const legend = [...plan.order].sort((a, b) => a.rank - b.rank);
  const summary = `Total balance falls from ${formatCents(startCents)} to zero${
    end ? ` by ${end}` : ""
  }. ${legend
    .map(
      (d) =>
        `${d.rank}, ${d.label}: paid off ${d.payoff_month ? formatMonthShort(d.payoff_month) : "now"}`,
    )
    .join(". ")}.`;
  return (
    <figure className="payoff-chart">
      <div ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={summary}>
          <line
            x1={SIDE}
            x2={W - SIDE}
            y1={H - BOTTOM}
            y2={H - BOTTOM}
            stroke="var(--c-line)"
            strokeWidth="1"
          />
          <text x={SIDE} y={14} className="payoff-chart__label">
            {shortMoney(startCents)} now
          </text>
          {showOther ? (
            <polyline
              points={line(showOther)}
              fill="none"
              stroke="var(--c-sub)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          ) : null}
          <polyline
            points={line(plan)}
            fill="none"
            stroke="var(--c-a1)"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {placed.map((p) => (
            <g key={p.id}>
              <circle cx={p.cx} cy={p.cy} r={MARK_R} fill="var(--c-a1)" />
              <text x={p.cx} y={p.cy + 4} className="payoff-chart__mark">
                {p.rank}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="forecast__axis" aria-hidden="true">
        <span>Now</span>
        <span>{end ? `Debt-free ${end}` : ""}</span>
      </div>
      <ol className="payoff-chart__legend" aria-hidden="true">
        {legend.map((d) => (
          <li key={d.id}>
            <span className="payoff-chart__dot">{d.rank}</span>
            <span className="payoff-chart__name">{d.label}</span>
            <span className="payoff-chart__when">
              {d.payoff_month ? formatMonthShort(d.payoff_month) : "Now"}
            </span>
          </li>
        ))}
      </ol>
      {showOther && otherLabel ? (
        <p className="forecast__legend" aria-hidden="true">
          <span>
            <i className="payoff-chart__key payoff-chart__key--on" /> This order
          </span>
          <span>
            <i className="payoff-chart__key payoff-chart__key--other" /> {otherLabel}
          </span>
        </p>
      ) : null}
    </figure>
  );
}

/** Home's tiny version: the same line, no labels (the card's month says the rest). */
export function PayoffSparkline({ plan, startCents }: { plan: PayoffPlan; startCents: number }) {
  const [box, W] = useBoxWidth(240, 120);
  const n = monthsOf(plan);
  if (plan.stalled || n < 1 || startCents <= 0) return null;
  const h = 36;
  const x = (i: number) => 3 + (i / n) * (W - 6);
  const y = (v: number) => 3 + (1 - v / startCents) * (h - 6);
  const pts = Array.from(
    { length: n + 1 },
    (_, i) => `${x(i).toFixed(1)},${y(valueAt(plan, startCents, i)).toFixed(1)}`,
  ).join(" ");
  return (
    <div ref={box} className="payoff-spark">
      <svg viewBox={`0 0 ${W} ${h}`} width={W} height={h} aria-hidden="true">
        <polyline
          points={pts}
          fill="none"
          stroke="var(--c-a1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(n)} cy={y(0)} r="4" fill="var(--c-a1)" />
      </svg>
    </div>
  );
}
