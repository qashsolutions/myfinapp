import { Card } from "@stackd/ui";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { wordTone } from "../../app/layout/Word.tsx";
import { formatCents, formatDay } from "../../lib/format.ts";

/**
 * One summary card on Insights (owner decision, October 25, 2026: one word of value first, then a
 * short line): the area's name, the word, a short line with the number, and a small picture. The
 * whole card opens the detail screen.
 */
export function InsightCard({
  title,
  word,
  line,
  to,
  tag,
  children,
}: {
  title: string;
  word: string;
  line: ReactNode;
  to: string;
  tag?: ReactNode;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const tone = { good: " insight-card__word--good", bad: " insight-card__word--bad", plain: "" }[
    wordTone(word)
  ];
  return (
    <Card
      as="div"
      aria-label={title}
      className="card-link insight-card"
      role="link"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(to);
        }
      }}
    >
      <div className="insight-card__top">
        <span className="insight-card__title">{title}</span>
        {tag}
      </div>
      <span className={`insight-card__headline${tone}`}>{word}</span>
      <span className="insight-card__line">{line}</span>
      {children ? <div className="insight-card__visual">{children}</div> : null}
    </Card>
  );
}

/** Two bars side by side: money in and money out, widths relative to the larger. */
export function InOutBars({ inCents, outCents }: { inCents: number; outCents: number }) {
  const max = Math.max(inCents, outCents, 1);
  return (
    <div className="inout" aria-hidden="true">
      <span className="inout__bar inout__bar--in" style={{ width: `${(inCents / max) * 100}%` }} />
      <span
        className="inout__bar inout__bar--out"
        style={{ width: `${(outCents / max) * 100}%` }}
      />
    </div>
  );
}

/** A ring filled to a percentage, with the number in the middle. */
export function Ring({ pct, label }: { pct: number; label?: string }) {
  return (
    <span
      className="insight-ring"
      style={{ "--ring-pct": `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties}
      aria-hidden="true"
    >
      {label ?? `${Math.round(pct)}%`}
    </span>
  );
}

/**
 * The estimated balance until payday, read without help (owner, October 19, 2026: a bare line
 * meant nothing): today's balance and the lowest point labelled with their amounts and dates, the
 * cushion as a labelled dashed line, the room above it shaded green and any dip below it red, and
 * the ends of the date axis. Every amount drawn is one of the forecast's own daily balances.
 */
export function BalanceRunway({
  days,
  cushionCents,
  endLabel,
}: {
  days: Array<{ date: string; balance_cents: number }>;
  cushionCents: number;
  endLabel: string;
}) {
  const id = useId();
  // Drawn at the card's real width (one unit = one pixel), so labels keep their size on any card.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0) setW(Math.max(240, width));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  if (days.length < 2) return <div ref={box} className="runway-box" />;
  const top = 22;
  const bottom = 92;
  const left = 6;
  const right = W - 6;
  const balances = days.map((d) => d.balance_cents);
  let lowIndex = 0;
  for (const [i, b] of balances.entries()) if (b < (balances[lowIndex] ?? b)) lowIndex = i;
  const low = days[lowIndex] ?? days[0];
  const lo = Math.min(...balances, cushionCents);
  const hi = Math.max(...balances, cushionCents);
  const span = hi - lo || 1;
  const x = (i: number) => left + (i / (days.length - 1)) * (right - left);
  const y = (v: number) => bottom - ((v - lo) / span) * (bottom - top);
  const line = balances.map((b, i) => `${x(i).toFixed(1)},${y(b).toFixed(1)}`).join(" ");
  const cy = y(cushionCents);
  const area = `${left},${cy} ${line} ${right},${cy}`;
  const lowX = x(lowIndex);
  const below = (low?.balance_cents ?? 0) < cushionCents;
  // The low label sits clear of the line: beside the dot, on the side the line isn't (an end point
  // gets it to its left, under the falling line; a start point to its right), else under the dot,
  // where the line never is since this is the lowest point (October 20, 2026).
  const lowY = y(low?.balance_cents ?? 0);
  const atEnd = lowIndex === days.length - 1;
  const atStart = lowIndex === 0;
  const lowAnchor = atEnd
    ? "end"
    : atStart
      ? "start"
      : lowX < 90
        ? "start"
        : lowX > W - 90
          ? "end"
          : "middle";
  const lowTextX = atEnd ? lowX - 12 : atStart ? lowX + 12 : lowX;
  const lowTextY = atEnd || atStart ? Math.min(lowY + 4, 100) : lowY + 15;
  const showStart = lowIndex > 0;
  return (
    <div ref={box} className="runway-box">
      <svg
        className="runway"
        width={W}
        height={130}
        viewBox={`0 0 ${W} 130`}
        role="img"
        aria-label={`Estimated balance: ${formatCents(balances[0] ?? 0)} today, lowest ${formatCents(low?.balance_cents ?? 0)} on ${formatDay(low?.date ?? "")}, cushion ${formatCents(cushionCents)}`}
      >
        <defs>
          <clipPath id={`${id}-up`}>
            <rect x="0" y="0" width={W} height={cy} />
          </clipPath>
          <clipPath id={`${id}-down`}>
            <rect x="0" y={cy} width={W} height={130 - cy} />
          </clipPath>
        </defs>
        <polygon className="runway__room" points={area} clipPath={`url(#${id}-up)`} />
        <polygon className="runway__short" points={area} clipPath={`url(#${id}-down)`} />
        <line className="runway__cushion" x1={left} x2={right} y1={cy} y2={cy} />
        <text className="runway__note" x={right} y={cy - 4} textAnchor="end">
          Cushion {formatCents(cushionCents)}
        </text>
        <polyline className="runway__line" points={line} />
        {showStart ? (
          <>
            <circle className="runway__dot" cx={x(0)} cy={y(balances[0] ?? 0)} r="3.5" />
            <text className="runway__label" x={left} y={Math.max(12, y(balances[0] ?? 0) - 8)}>
              {formatCents(balances[0] ?? 0)}
            </text>
          </>
        ) : null}
        <circle
          className={below ? "runway__dot runway__dot--short" : "runway__dot runway__dot--room"}
          cx={lowX}
          cy={lowY}
          r="4"
        />
        <text
          className={below ? "runway__label runway__label--short" : "runway__label"}
          x={lowTextX}
          y={lowTextY}
          textAnchor={lowAnchor}
        >
          Low {formatCents(low?.balance_cents ?? 0)} · {formatDay(low?.date ?? "")}
        </text>
        <text className="runway__axis" x={left} y="126">
          Today
        </text>
        <text className="runway__axis" x={right} y="126" textAnchor="end">
          {endLabel}
        </text>
      </svg>
    </div>
  );
}

/** Planned vs spent per budget bucket, one thin bar each. */
export function BucketBars({
  buckets,
}: {
  buckets: Array<{ bucket: string; planned_cents: number; spent_cents: number }>;
}) {
  const names: Record<string, string> = { need: "Needs", want: "Wants", save: "Save" };
  return (
    <div className="bucket-bars" aria-hidden="true">
      {buckets.map((b) => {
        const pct = b.planned_cents > 0 ? (b.spent_cents / b.planned_cents) * 100 : 0;
        return (
          <div className="bucket-bars__row" key={b.bucket}>
            <span className="bucket-bars__name">{names[b.bucket] ?? b.bucket}</span>
            <span className="bucket-bars__track">
              <span
                className={`bucket-bars__fill${pct > 100 ? " bucket-bars__fill--over" : ""}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}
