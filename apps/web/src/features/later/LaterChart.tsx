import type { LaterProjection } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

const W = 354;
const H = 190;
const LEFT = 4;
const TOP = 14;
const BOTTOM = 22;

/** Short money for the axis: $850, $12k, $1.2m. */
export function shortMoney(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}m`;
  if (d >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}

/**
 * Savings by age (October 25, 2026): the band between the lowest and highest rate shaded, the
 * middle rate as the line, what was put in as a thin line, and the goal dashed.
 */
export function LaterChart({ p }: { p: LaterProjection }) {
  const pts = p.points;
  if (pts.length < 2) return null;
  const last = pts.length - 1;
  const lo = (i: number) => pts[i]?.balances_cents[0] ?? 0;
  const hi = (i: number) => {
    const b = pts[i]?.balances_cents ?? [];
    return b[b.length - 1] ?? 0;
  };
  const mid = (i: number) => pts[i]?.balances_cents[p.middle_index] ?? 0;
  const max = Math.max(hi(last), p.target_cents, 1);
  const x = (i: number) => LEFT + (i / last) * (W - LEFT - 2);
  const y = (v: number) => TOP + (1 - v / max) * (H - TOP - BOTTOM);
  const path = (f: (i: number) => number) =>
    pts.map((_, i) => `${x(i).toFixed(1)},${y(f(i)).toFixed(1)}`).join(" ");
  const band = `${path(hi)} ${pts
    .map((_, i) => `${x(last - i).toFixed(1)},${y(lo(last - i)).toFixed(1)}`)
    .join(" ")}`;
  const first = pts[0] as { age: number };
  const end = pts[last] as { age: number; contributed_cents: number };
  const midAge = pts[Math.floor(last / 2)] as { age: number };
  return (
    <>
      <svg
        className="later__chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Savings from age ${first.age} to ${end.age}: ${formatCents(lo(last))} to ${formatCents(hi(last))}, about ${formatCents(mid(last))} at the middle rate.${p.target_cents > 0 ? ` Goal ${formatCents(p.target_cents)}.` : ""}`}
      >
        <line x1={LEFT} y1={H - BOTTOM} x2={W} y2={H - BOTTOM} stroke="var(--c-line)" />
        <polygon points={band} fill="var(--c-a2)" opacity="0.35" />
        <polyline
          points={path((i) => pts[i]?.contributed_cents ?? 0)}
          fill="none"
          stroke="var(--c-sub)"
          strokeWidth="1.5"
        />
        <polyline
          points={path(mid)}
          fill="none"
          stroke="var(--c-a1)"
          strokeWidth="3.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {p.target_cents > 0 ? (
          <>
            <line
              x1={LEFT}
              x2={W}
              y1={y(p.target_cents)}
              y2={y(p.target_cents)}
              stroke={p.reaches_target ? "var(--c-success)" : "var(--c-danger)"}
              strokeDasharray="6 4"
              strokeWidth="1.5"
            />
            <text x={W - 2} y={y(p.target_cents) - 4} className="later__goal">
              Goal {shortMoney(p.target_cents)}
            </text>
          </>
        ) : null}
        <circle cx={x(last)} cy={y(mid(last))} r="5" fill="var(--c-a1)" />
        <text x={W - 2} y={Math.max(12, y(mid(last)) - 8)} className="later__end">
          {shortMoney(mid(last))}
        </text>
      </svg>
      <div className="forecast__axis" aria-hidden="true">
        <span>{first.age}</span>
        <span>{midAge.age}</span>
        <span>{end.age}</span>
      </div>
      <div className="forecast__legend" aria-hidden="true">
        <span>
          <i className="forecast__key later__key--line" /> Middle rate
        </span>
        <span>
          <i className="forecast__key later__key--band" /> Low to high
        </span>
        <span>
          <i className="forecast__key later__key--in" /> Put in
        </span>
      </div>
    </>
  );
}
