import "../bills/visuals.css";

import { ProgressBar } from "@stackd/ui";
import type { CardTrend, CreditHabits } from "../../engine/bridge.ts";
import { formatCents, formatDay, formatMonthShort } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" or "2026-10-15" → "Oct"; one letter when the space is tight. */
function monthLabel(iso: string, tight: boolean): string {
  const name = SHORT[Number(iso.slice(5, 7)) - 1] ?? "";
  return tight ? name.slice(0, 1) : name;
}

/**
 * A card's spending against payments month by month (October 29, 2026): spent (red) and paid
 * (green) side by side for each month of `credit.card_trend`'s window, on one scale.
 */
export function CardPairBars({ trend }: { trend: CardTrend }) {
  const [box, boxW] = useBoxWidth(300, 200);
  // Bars stay grouped on a computer instead of spreading across a wide card.
  const W = Math.min(boxW, 480);
  const months = trend.months;
  if (months.length === 0) return null;
  const H = 84;
  const LABEL = 16;
  const max = Math.max(1, ...months.map((m) => Math.max(m.spent_cents, m.paid_cents)));
  const slot = W / months.length;
  const bar = Math.max(4, Math.min(16, (slot - 10) / 2));
  const h = (v: number) => Math.round((v / max) * (H - LABEL - 4));
  const summary = months
    .map(
      (m) =>
        `${formatMonthShort(m.month)}: spent ${formatCents(m.spent_cents)}, paid ${formatCents(m.paid_cents)}`,
    )
    .join(". ");
  return (
    <div className="pair-bars">
      <div ref={box}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`Spent and paid each month. ${summary}.`}
        >
          {months.map((m, i) => {
            const mid = slot * i + slot / 2;
            const base = H - LABEL;
            return (
              <g key={m.month}>
                <rect
                  x={mid - bar - 1}
                  y={base - h(m.spent_cents)}
                  width={bar}
                  height={h(m.spent_cents)}
                  rx="2"
                  fill="var(--c-danger)"
                />
                <rect
                  x={mid + 1}
                  y={base - h(m.paid_cents)}
                  width={bar}
                  height={h(m.paid_cents)}
                  rx="2"
                  fill="var(--c-success)"
                />
                <text x={mid} y={H - 3} className="pair-bars__label">
                  {monthLabel(m.month, slot < 30)}
                </text>
              </g>
            );
          })}
          <line x1="0" x2={W} y1={H - LABEL} y2={H - LABEL} stroke="var(--c-line)" />
        </svg>
      </div>
      <p className="due-dots__legend" aria-hidden="true">
        <span>
          <i className="pair-bars__key pair-bars__key--spent" /> Spent
        </span>
        <span>
          <i className="pair-bars__key pair-bars__key--paid" /> Paid
        </span>
      </p>
    </div>
  );
}

const LEGEND = { on_time: "On time", missed: "Missed", unknown: "Not known" } as const;
const RESULT_TEXT = { on_time: "on time", missed: "missed", unknown: "not known" } as const;

/**
 * The last 12 due dates as dots (October 29, 2026): green on time, red missed, a grey ring when
 * the person's data can't tell, and the next one as a dashed ring (not yet). Month under each.
 */
export function DueDots({ habits, compact = false }: { habits: CreditHabits; compact?: boolean }) {
  const [box, W] = useBoxWidth(300, 160);
  const past = habits.dues.slice(-12);
  const next = habits.next_due_date;
  const count = past.length + (next ? 1 : 0);
  if (count === 0) return null;
  const R = compact ? 6 : 8;
  const H = compact ? 2 * R + 6 : 2 * R + 24;
  const slot = Math.min(W / count, 40);
  const left = 0;
  const tight = slot < 30;
  const cx = (i: number) => left + slot * i + slot / 2;
  const cy = R + 3;
  const text = [
    ...past.map((d) => `${formatDay(d.due_date)} ${RESULT_TEXT[d.result]}`),
    ...(next ? [`${formatDay(next)} not yet`] : []),
  ].join(", ");
  return (
    <div className="due-dots">
      <div ref={box}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`Due dates: ${text}.`}
        >
          {past.map((d, i) => (
            <g key={d.due_date}>
              {d.result === "unknown" ? (
                <circle
                  cx={cx(i)}
                  cy={cy}
                  r={R - 1}
                  fill="none"
                  stroke="var(--c-sub)"
                  strokeWidth="2"
                />
              ) : (
                <circle
                  cx={cx(i)}
                  cy={cy}
                  r={R}
                  fill={d.result === "on_time" ? "var(--c-success)" : "var(--c-danger)"}
                />
              )}
              {compact ? null : (
                <text x={cx(i)} y={H - 4} className="due-dots__label">
                  {monthLabel(d.due_date, tight)}
                </text>
              )}
            </g>
          ))}
          {next ? (
            <g>
              <circle
                cx={cx(past.length)}
                cy={cy}
                r={R - 1}
                fill="none"
                stroke="var(--c-ink)"
                strokeWidth="2"
                strokeDasharray="3 2"
              />
              {compact ? null : (
                <text x={cx(past.length)} y={H - 4} className="due-dots__label">
                  {monthLabel(next, tight)}
                </text>
              )}
            </g>
          ) : null}
        </svg>
      </div>
      {compact ? null : (
        <p className="due-dots__legend" aria-hidden="true">
          {(["on_time", "missed", "unknown"] as const)
            .filter((r) => past.some((d) => d.result === r))
            .map((r) => (
              <span key={r}>
                <i className={`due-dots__key due-dots__key--${r}`} /> {LEGEND[r]}
              </span>
            ))}
          {next ? (
            <span>
              <i className="due-dots__key due-dots__key--next" /> Next
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}

function pct(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

/** The share of the limit used as a bar with the person's guide marked (October 29, 2026). */
export function LimitGauge({ habits, guideBps }: { habits: CreditHabits; guideBps: number }) {
  if (habits.utilization_bps === null) return null;
  const used = habits.utilization_bps;
  return (
    <div className="credit-gauge">
      <div className="credit-gauge__top">
        <span>Limit used</span>
        <span className="credit-gauge__value">{pct(used)}</span>
      </div>
      <ProgressBar
        fraction={used / 10000}
        label="Limit used"
        valueText={`${pct(used)} of the limit used`}
        tone={habits.under_guide ? "success" : "warning"}
        marks={[{ at: guideBps / 10000, label: `Guide ${pct(guideBps)}` }]}
        showMarkLabels
      />
    </div>
  );
}

/** Paid in full, as a small count (October 29, 2026). */
export function FullStreak({ habits }: { habits: CreditHabits }) {
  if (!habits.paid_in_full_streak) return null;
  const n = habits.paid_in_full_streak;
  return (
    <p className="full-streak">
      Paid in full <span className="full-streak__n">{n}</span> {n === 1 ? "month" : "months"}
    </p>
  );
}
