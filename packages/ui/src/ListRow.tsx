import type { HTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx.ts";

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  /** Draw the card surface around the list. */
  card?: boolean;
}

export function List({ card = false, className, ...rest }: ListProps) {
  return <ul className={cx("sk-list", card && "sk-list--card", className)} {...rest} />;
}

export interface ListRowProps {
  label: ReactNode;
  sublabel?: ReactNode;
  value?: ReactNode;
  valueTone?: "default" | "sub" | "success" | "warning" | "danger";
  leading?: ReactNode;
  /** Makes the row a button; with `href` it is called on the link (preventDefault to route client-side). */
  onClick?: MouseEventHandler<HTMLElement>;
  /** Makes the row a link. */
  href?: string;
  /** Show the chevron on navigational rows (default: when `href` is set). */
  chevron?: boolean;
  className?: string;
  /** Put on the list item, so a search result can point at this row. */
  id?: string;
}

/**
 * One line of a list: label, optional sublabel, optional value on the right. Plain by default;
 * a real <button> or <a> when it does something, so it is focusable and announced correctly.
 */
export function ListRow({
  label,
  sublabel,
  value,
  valueTone = "default",
  leading,
  onClick,
  href,
  chevron,
  className,
  id,
}: ListRowProps) {
  const showChevron = chevron ?? Boolean(href);
  const body = (
    <>
      {leading ? <span className="sk-row__leading">{leading}</span> : null}
      <span className="sk-row__text">
        <span className="sk-row__label">{label}</span>
        {sublabel ? <span className="sk-row__sublabel">{sublabel}</span> : null}
      </span>
      {value !== undefined ? (
        <span className={cx("sk-row__value", `sk-row__value--${valueTone}`)}>{value}</span>
      ) : null}
      {showChevron ? (
        <svg
          className="sk-row__chevron"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          aria-hidden="true"
        >
          <path
            d="M9 6l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </>
  );
  const cls = cx("sk-row", (onClick || href) && "sk-row--interactive", className);
  if (href) {
    return (
      <li className="sk-list__item" id={id}>
        <a className={cls} href={href} onClick={onClick}>
          {body}
        </a>
      </li>
    );
  }
  if (onClick) {
    return (
      <li className="sk-list__item" id={id}>
        <button type="button" className={cls} onClick={onClick}>
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="sk-list__item" id={id}>
      <div className={cls}>{body}</div>
    </li>
  );
}
