import { cx } from "./cx.ts";

export interface ProgressBarProps {
  /** 0..1; values above 1 render full and are reported as 100. */
  fraction: number;
  /** Accessible name, e.g. "Travel jar". */
  label: string;
  /** Text equivalent, e.g. "69% of $600" (docs/spec.md accessibility). */
  valueText: string;
  /** Also render the text equivalent under the bar. */
  showText?: boolean;
  tone?: "accent" | "success" | "warning" | "danger";
  className?: string;
  /**
   * Thin ticks on the track (October 29, 2026), e.g. a budget line's "Tell me at" and its plan
   * end, or a card's 30% guide: `at` is 0..1 along the track; `label` is shown under the tick
   * when `showMarkLabels` is set and is always part of the text equivalent.
   */
  marks?: ReadonlyArray<{ at: number; label: string }>;
  showMarkLabels?: boolean;
}

export function ProgressBar({
  fraction,
  label,
  valueText,
  showText = false,
  tone,
  className,
  marks,
  showMarkLabels = false,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const pct = Math.round(clamped * 100);
  const resolvedTone = tone ?? (clamped >= 1 ? "success" : "accent");
  const ticks = (marks ?? []).map((m) => ({
    ...m,
    pct: Math.max(0, Math.min(100, Math.round((Number.isFinite(m.at) ? m.at : 0) * 1000) / 10)),
  }));
  const fullText = ticks.length
    ? `${valueText} · ${ticks.map((t) => t.label).join(" · ")}`
    : valueText;
  const track = (
    <div
      className={cx("sk-progress__track", `sk-progress__track--${resolvedTone}`)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={fullText}
    >
      <div className="sk-progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
  return (
    <div className={cx("sk-progress", className)}>
      {ticks.length ? (
        <div className="sk-progress__marked">
          {track}
          {ticks.map((t) => (
            <span
              key={t.label}
              className="sk-progress__mark"
              style={{ left: `${t.pct}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
      ) : (
        track
      )}
      {showMarkLabels && ticks.length ? (
        <div className="sk-progress__marks" aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t.label}
              className={cx(
                "sk-progress__mark-label",
                t.pct > 70 && "sk-progress__mark-label--end",
                t.pct < 15 && "sk-progress__mark-label--start",
              )}
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      ) : null}
      {showText ? <span className="sk-progress__text">{valueText}</span> : null}
    </div>
  );
}
