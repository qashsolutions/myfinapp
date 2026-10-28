import { useId } from "react";
import { cx } from "./cx.ts";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  /** The row already names it (a list row's title): keep the label for screen readers only. */
  hideLabel?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * A switch row. A native checkbox with role="switch" so keyboard, screen readers and
 * form semantics come for free; the track is drawn by CSS and takes --radius-toggle
 * (pill in Modern and Pastel, rounded square in Anime).
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  hideLabel = false,
  disabled,
  id,
  className,
}: ToggleProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const labelId = `${inputId}-label`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <label
      className={cx(
        "sk-toggle",
        disabled && "sk-toggle--disabled",
        hideLabel && "sk-toggle--bare",
        className,
      )}
      htmlFor={inputId}
    >
      <span className="sk-toggle__text">
        <span className={cx("sk-toggle__label", hideLabel && "sk-visually-hidden")} id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="sk-toggle__desc" id={descId}>
            {description}
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        className="sk-toggle__input"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sk-toggle__track" aria-hidden="true">
        <span className="sk-toggle__thumb" />
      </span>
    </label>
  );
}
