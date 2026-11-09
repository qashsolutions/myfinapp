import { useId } from "react";

/** One row of chips for a fixed choice (a kind, a split method, a repeat): radio inputs. */
export function ChipChoice<T extends string | null>({
  legend,
  options,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="split-chips" disabled={disabled}>
      <legend className="auth__label">{legend}</legend>
      <div className="kind-chips">
        {options.map(([v, label]) => (
          <label className="chip-option" key={label}>
            <input
              className="segmented__input"
              type="radio"
              name={name}
              checked={value === v}
              onChange={() => onChange(v)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
