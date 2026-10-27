import { cx } from "@stackd/ui";
import { useId } from "react";

export interface CodeInputProps {
  value: string;
  onChange: (digits: string) => void;
  length?: number;
  disabled?: boolean;
  describedBy?: string;
}

/**
 * The 6-digit code: one real input (so paste, autofill from the email, and screen readers
 * work) drawn as six boxes.
 */
export function CodeInput({ value, onChange, length = 6, disabled, describedBy }: CodeInputProps) {
  const id = useId();
  const digits = value.slice(0, length);
  const active = Math.min(digits.length, length - 1);
  const slots = Array.from({ length }, (_, i) => ({
    key: `${id}-slot-${i}`,
    digit: digits[i] ?? "",
    active: i === active,
  }));
  return (
    <div className="code">
      <input
        id={id}
        className="code__input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        aria-label={`${length}-digit code`}
        aria-describedby={describedBy}
        value={digits}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
          if (text) {
            e.preventDefault();
            onChange(text);
          }
        }}
      />
      <div className="code__boxes" aria-hidden="true">
        {slots.map((slot) => (
          <span className={cx("code__box", slot.active && "code__box--active")} key={slot.key}>
            {slot.digit}
          </span>
        ))}
      </div>
    </div>
  );
}
