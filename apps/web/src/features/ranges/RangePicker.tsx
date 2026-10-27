import "./ranges.css";

import { useId } from "react";
import { RANGE_NAME, RANGES, type RangeBounds, type RangeChoice } from "./ranges.ts";

const SHOWN: Record<RangeChoice, string> = {
  Month: "Month",
  Quarter: "Quarter",
  Year: "Year",
  YTD: "YTD",
  Next: "Next",
};

/** One row of chips: Month · Quarter · Year · YTD, and Next where the screen looks forward. */
export function RangePicker<R extends RangeChoice>({
  value,
  onChange,
  next = false,
  label = "Time range",
}: {
  value: R;
  onChange: (range: R) => void;
  next?: boolean;
  label?: string;
}) {
  const ids = useId();
  const options: RangeChoice[] = next ? [...RANGES, "Next"] : [...RANGES];
  return (
    <fieldset className="range-picker">
      <legend className="sr-only">{label}</legend>
      {options.map((r) => (
        <label className="range-picker__option" key={r}>
          <input
            className="range-picker__input"
            type="radio"
            name={`${ids}-range`}
            checked={value === r}
            onChange={() => onChange(r as R)}
          />
          <span aria-hidden="true">{SHOWN[r]}</span>
          <span className="sr-only">{RANGE_NAME[r]}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** "‹ Earlier · Nov 2025 – Oct 2026 · Later ›": a whole period back or forward at a time. */
export function RangeStepper({
  bounds,
  onBack,
}: {
  bounds: RangeBounds | null;
  onBack: (back: number) => void;
}) {
  if (!bounds) return null;
  return (
    <div className="range-stepper">
      <button
        type="button"
        className="range-stepper__btn"
        onClick={() => onBack(bounds.back + 1)}
        disabled={!bounds.hasEarlier}
      >
        ‹ Earlier
      </button>
      <span className="range-stepper__label" aria-live="polite">
        {bounds.label}
      </span>
      <button
        type="button"
        className="range-stepper__btn"
        onClick={() => onBack(bounds.back - 1)}
        disabled={bounds.back === 0}
      >
        Later ›
      </button>
    </div>
  );
}
