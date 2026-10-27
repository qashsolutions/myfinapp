import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** `accent` is the hero card: accent-1 background, on-accent text. */
  tone?: "default" | "accent";
  /** Rendered element; `section` when the card has its own heading. */
  as?: ElementType;
  /** Marks a purely decorative card that Simple layout hides. */
  decor?: boolean;
  children?: ReactNode;
}

export function Card({
  tone = "default",
  as: Tag = "div",
  decor = false,
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cx(
        "sk-card",
        tone === "accent" && "sk-card--accent",
        decor && "sk-decor",
        className,
      )}
      {...rest}
    />
  );
}
