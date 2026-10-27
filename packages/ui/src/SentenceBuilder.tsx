import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type SentencePart =
  | string
  | {
      /** A blank the user taps to change. */
      key: string;
      label: ReactNode;
      /** Accessible name, e.g. "Change amount". */
      change: string;
      onClick: () => void;
      disabled?: boolean;
    };

export interface SentenceBuilderProps {
  parts: SentencePart[];
  hint?: string;
  className?: string;
}

/**
 * "Save [$2,000] for [Travel] by [Jun 2027]": users fill the blanks, never write rules
 * (docs/spec.md "Goals & challenges"). Each blank is a real button.
 */
export function SentenceBuilder({
  parts,
  hint = "Tap a highlighted word to change it",
  className,
}: SentenceBuilderProps) {
  return (
    <div className={cx("sk-sentence", className)}>
      {hint ? <p className="sk-sentence__hint">{hint}</p> : null}
      <p className="sk-sentence__text">
        {parts.map((part, i) =>
          typeof part === "string" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: plain words never reorder
            <span key={`w${i}`}>{part}</span>
          ) : (
            <button
              key={part.key}
              type="button"
              className="sk-sentence__blank"
              aria-label={part.change}
              onClick={part.onClick}
              disabled={part.disabled}
            >
              {part.label}
            </button>
          ),
        )}
      </p>
    </div>
  );
}
