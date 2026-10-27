import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Stretch to the container's width. */
  block?: boolean;
}

/** Class list for something that should look like a button but is a link (router NavLink). */
export function buttonClass(opts: Pick<ButtonProps, "variant" | "size" | "block"> = {}): string {
  const { variant = "primary", size = "md", block = false } = opts;
  return cx(
    "sk-btn",
    `sk-btn--${variant}`,
    size === "sm" && "sk-btn--sm",
    block && "sk-btn--block",
  );
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(buttonClass({ variant, size, block }), className)}
      {...rest}
    />
  );
}
