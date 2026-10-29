import type { SubscriptionCheck } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";
import { kindLabel } from "./kinds.ts";

/** The top kinds get their own colour; the rest, and No kind, share the quiet one. */
const COLOURS = ["var(--c-a1)", "var(--c-a2)", "var(--c-a3)", "var(--c-ink)"];
const REST = "var(--c-sub)";
const GAP = 2;

type KindRow = SubscriptionCheck["by_kind"][number];

export function kindColour(rows: KindRow[], index: number): string {
  const row = rows[index];
  if (!row || row.kind === null) return REST;
  const named = rows.slice(0, index).filter((r) => r.kind !== null).length;
  return COLOURS[named] ?? REST;
}

/** "Video streaming $33.49 a month, Music $12.99 a month" for screen readers. */
export function kindBarText(rows: KindRow[], labels?: ReadonlyMap<string, string>): string {
  return rows
    .map((r) => `${kindLabel(r.kind, labels)} ${formatCents(r.monthly_cents)} a month`)
    .join(", ");
}

/**
 * Where the subscription money goes (October 29, 2026): one bar split by kind, widest first, from
 * `recurring.subscription_check`'s `by_kind`. The widths are only a picture of the engine's
 * monthly amounts; every number shown comes from the rule.
 */
export function KindBar({
  rows,
  height = 16,
  labels,
}: {
  rows: KindRow[];
  height?: number;
  /** The person's own kinds, id → name. */
  labels?: ReadonlyMap<string, string>;
}) {
  const [box, width] = useBoxWidth(320, 120);
  const total = rows.reduce((s, r) => s + r.monthly_cents, 0);
  const usable = Math.max(0, width - GAP * Math.max(0, rows.length - 1));
  let x = 0;
  const segments = rows.map((r, i) => {
    const w = total > 0 ? Math.max(2, Math.round((r.monthly_cents / total) * usable)) : 0;
    const seg = { key: r.kind ?? "none", x, w, fill: kindColour(rows, i) };
    x += w + GAP;
    return seg;
  });
  return (
    <div ref={box} className="subs__bar">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Where it goes each month: ${kindBarText(rows, labels)}`}
      >
        <rect x={0} y={0} width={width} height={height} rx={height / 2} fill="var(--c-line)" />
        {segments.map((s) => (
          <rect
            key={s.key}
            x={s.x}
            y={0}
            width={Math.min(s.w, Math.max(0, width - s.x))}
            height={height}
            rx={Math.min(4, height / 2)}
            fill={s.fill}
          />
        ))}
      </svg>
    </div>
  );
}

/** The legend under the bar: each kind's swatch, how many, and what it costs a month. */
export function KindLegend({
  rows,
  labels,
}: {
  rows: KindRow[];
  labels?: ReadonlyMap<string, string>;
}) {
  return (
    <ul className="subs__legend" aria-label="By kind">
      {rows.map((r, i) => (
        <li key={r.kind ?? "none"}>
          <span className="subs__swatch" style={{ background: kindColour(rows, i) }} aria-hidden />
          <span className="subs__legend-name">
            {kindLabel(r.kind, labels)}
            {r.count > 1 ? ` · ${r.count}` : ""}
          </span>
          <span className="subs__legend-value">{formatCents(r.monthly_cents)} a month</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One subscription's yearly cost against all of them (the Check card): a filled bar with the
 * two amounts from the engine as its labels.
 */
export function YearShareBar({
  label,
  yearlyCents,
  totalYearlyCents,
}: {
  label: string;
  yearlyCents: number;
  totalYearlyCents: number;
}) {
  const [box, width] = useBoxWidth(320, 120);
  const height = 12;
  const w = totalYearlyCents > 0 ? Math.round((yearlyCents / totalYearlyCents) * width) : 0;
  const text = `${formatCents(yearlyCents)} of ${formatCents(totalYearlyCents)} a year`;
  return (
    <div ref={box} className="subs__bar">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: ${text}`}
      >
        <rect x={0} y={0} width={width} height={height} rx={height / 2} fill="var(--c-line)" />
        <rect
          x={0}
          y={0}
          width={Math.max(w, 4)}
          height={height}
          rx={height / 2}
          fill="var(--c-a1)"
        />
      </svg>
      <p className="subs__bar-label" aria-hidden>
        <strong>{formatCents(yearlyCents)}</strong>
        <span> of {formatCents(totalYearlyCents)} a year on subscriptions</span>
      </p>
    </div>
  );
}
