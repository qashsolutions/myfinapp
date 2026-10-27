import "./ranges.css";

import type { SeriesStep, SeriesStepKind } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function stepLabel(step: SeriesStep, kind: SeriesStepKind): string {
  const m = Number(step.start.slice(5, 7));
  if (kind === "week") return `${SHORT[m - 1]} ${Number(step.start.slice(8, 10))}`;
  if (kind === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ’${step.start.slice(2, 4)}`;
  return SHORT[m - 1] ?? step.start;
}

/**
 * In vs Out per step, In green and Out red, from the first step with entries (short history is
 * never padded with $0 bars). A month's bars open that month when `onPick` is given.
 */
export function RangeBars({
  steps,
  kind,
  onPick,
}: {
  steps: SeriesStep[];
  kind: SeriesStepKind;
  onPick?: (step: SeriesStep) => void;
}) {
  const firstWithData = steps.findIndex((s) => s.count > 0);
  const shown = firstWithData < 0 ? [] : steps.slice(firstWithData);
  if (shown.length === 0) return null;
  const max = Math.max(1, ...shown.flatMap((s) => [s.in_cents, Math.max(0, s.out_cents)]));
  const h = (cents: number) => `${cents <= 0 ? 0 : Math.max(3, Math.round((cents / max) * 100))}%`;
  // Show every label when they fit; otherwise every other, so they never collide.
  const every = shown.length > 8 ? 2 : 1;
  return (
    <div className="range-bars" data-count={shown.length}>
      {shown.map((s, i) => {
        const label = stepLabel(s, kind);
        const name = `${label}: in ${formatCents(s.in_cents)}, out ${formatCents(s.out_cents)}, kept ${formatCents(s.net_cents)}`;
        const body = (
          <>
            <span className="range-bars__pair" aria-hidden="true">
              <span
                className="range-bars__bar range-bars__bar--in"
                style={{ height: h(s.in_cents) }}
              />
              <span
                className="range-bars__bar range-bars__bar--out"
                style={{ height: h(s.out_cents) }}
              />
            </span>
            <span className="range-bars__label" aria-hidden="true">
              {i % every === 0 || i === shown.length - 1 ? label : ""}
            </span>
          </>
        );
        return onPick && kind === "month" ? (
          <button
            type="button"
            key={s.start}
            className="range-bars__step range-bars__step--pick"
            aria-label={`${name}. Open ${label}`}
            onClick={() => onPick(s)}
          >
            {body}
          </button>
        ) : (
          <div key={s.start} className="range-bars__step" role="img" aria-label={name}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
