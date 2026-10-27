import type { HTMLAttributes } from "react";
import { cx } from "./cx.ts";

export type ChipTone = "neutral" | "accent" | "success" | "warning" | "danger" | "pending";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

/** A small pill label. Semantic tones are locked colours; never use an accent to mean an error. */
export function Chip({ tone = "neutral", className, ...rest }: ChipProps) {
  return <span className={cx("sk-chip", `sk-chip--${tone}`, className)} {...rest} />;
}
