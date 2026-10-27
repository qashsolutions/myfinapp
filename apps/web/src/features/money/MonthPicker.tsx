import { formatMonth } from "../../lib/format.ts";

/** ‹ October 2026 › */
export function MonthPicker({
  start,
  onShift,
  atLatest = false,
}: {
  start: string | null;
  onShift: (delta: number) => void;
  /** The month shown is this month: there is nothing later to count (October 27, 2026). */
  atLatest?: boolean;
}) {
  return (
    <div className="entries-month">
      <button
        type="button"
        className="entries-month__btn"
        aria-label="Previous month"
        onClick={() => onShift(-1)}
      >
        ‹
      </button>
      <span className="entries-month__label" aria-live="polite">
        {start ? formatMonth(start) : ""}
      </span>
      <button
        type="button"
        className="entries-month__btn"
        aria-label="Next month"
        disabled={atLatest}
        onClick={() => onShift(1)}
      >
        ›
      </button>
    </div>
  );
}
