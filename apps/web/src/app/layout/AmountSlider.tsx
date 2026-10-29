import { Button } from "@stackd/ui";
import { useId, useState } from "react";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

/**
 * An amount the person tries out again and again (UX pass, October 29, 2026): a slider that
 * redraws the picture as it moves, the exact value shown beside the words, and, when `own` is
 * set, a box for an exact amount read by the engine's `parseAmount`. The slider moves in
 * `step` cents; an amount off that grid (the plan's own $632.73) keeps its cents until moved.
 */
export function AmountSlider({
  label,
  suffix = "a month",
  value,
  max,
  step = 100,
  min = 0,
  onChange,
  own,
}: {
  /** The words before the amount, e.g. "If I put in". */
  label: string;
  suffix?: string;
  value: number;
  max: number;
  step?: number;
  min?: number;
  onChange: (cents: number) => void;
  /** The own-value box's accessible name; no box without it. */
  own?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const top = Math.max(max, value);
  async function use() {
    try {
      const cents = await parseAmount(text);
      if (cents < min) throw new Error("too small");
      setError(null);
      setText("");
      onChange(cents);
    } catch {
      setError(min > 0 ? "Enter an amount above zero, like 75." : "Enter an amount like 75.");
    }
  }
  return (
    <div className="amount-slider">
      <label className="amount-slider__label" htmlFor={id}>
        {label} <strong>{formatCents(value)}</strong> {suffix}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={top}
        step={step}
        value={value}
        aria-valuetext={`${formatCents(value)} ${suffix}`}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
      />
      <div className="amount-slider__ends" aria-hidden="true">
        <span>{formatCents(min)}</span>
        <span>{formatCents(top)}</span>
      </div>
      {own ? (
        <>
          <div className="amount-slider__own">
            <input
              className="auth__input"
              inputMode="decimal"
              placeholder="Or your own amount"
              aria-label={own}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void use();
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void use()}
              disabled={text.trim() === ""}
            >
              Use
            </Button>
          </div>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
