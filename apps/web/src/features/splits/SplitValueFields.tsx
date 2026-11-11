import type { SplitMethod } from "../../engine/bridge.ts";

/**
 * One person's value with its unit on screen ("$" before, "%" or "shares" after), so the box
 * says what goes in it (owner, November 11, 2026). The label stays "Sam, %" for screen readers.
 */
export function ValueBox({
  id,
  method,
  label,
  value,
  readOnly,
  onChange,
}: {
  id?: string;
  method: SplitMethod;
  label: string;
  value: string;
  readOnly?: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <span className="split-value">
      {method === "exact" ? (
        <span className="split-value__unit" aria-hidden="true">
          $
        </span>
      ) : null}
      <input
        id={id}
        className="auth__input"
        inputMode={method === "shares" ? "numeric" : "decimal"}
        aria-label={label}
        placeholder="0"
        readOnly={readOnly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {method === "percent" || method === "shares" ? (
        <span className="split-value__unit" aria-hidden="true">
          {method === "percent" ? "%" : "shares"}
        </span>
      ) : null}
    </span>
  );
}

/** The running total under the people, red until it adds up and green once it does. */
export function TotalLine({ total }: { total: { text: string; ok: boolean } | null }) {
  if (!total) return null;
  return (
    <p className={`split-total ${total.ok ? "split-total--ok" : "split-total--off"}`} role="status">
      {total.text}
    </p>
  );
}
