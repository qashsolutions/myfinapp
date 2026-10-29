import { ProgressBar } from "@stackd/ui";
import { paceMarks } from "./pace.ts";

/**
 * A budget line's bar with its two ticks (October 29, 2026): the person's "Tell me at" level
 * and the plan's end, so how close a line is shows as a position, not only the word. A small
 * key under the bar names the ticks.
 */
export function PaceBar({
  spentCents,
  plannedCents,
  levelBps,
  alerts,
  label,
  valueText,
  tone,
}: {
  spentCents: number;
  plannedCents: number;
  levelBps: number;
  /** False when the person turned the alert off for this line (or for every line). */
  alerts: boolean;
  label: string;
  valueText: string;
  tone?: "accent" | "success" | "warning" | "danger";
}) {
  const { scaleBps, marks } = paceMarks(levelBps, alerts);
  const fraction = plannedCents > 0 ? (spentCents / plannedCents) * (10000 / scaleBps) : 0;
  return (
    <div className="pace-bar">
      <ProgressBar
        fraction={fraction}
        label={label}
        valueText={valueText}
        tone={tone}
        marks={marks}
      />
      <span className="pace-bar__key" aria-hidden="true">
        {marks.map((m) => (
          <span key={m.label}>
            <i className="pace-bar__tick" /> {m.label}
          </span>
        ))}
      </span>
    </div>
  );
}
