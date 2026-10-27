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
}

export function ProgressBar({
  fraction,
  label,
  valueText,
  showText = false,
  tone,
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const pct = Math.round(clamped * 100);
  const resolvedTone = tone ?? (clamped >= 1 ? "success" : "accent");
  return (
    <div className={cx("sk-progress", className)}>
      <div
        className={cx("sk-progress__track", `sk-progress__track--${resolvedTone}`)}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={valueText}
      >
        <div className="sk-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      {showText ? <span className="sk-progress__text">{valueText}</span> : null}
    </div>
  );
}
