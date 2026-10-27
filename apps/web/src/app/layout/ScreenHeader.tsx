import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { AddChooser } from "./AddChooser.tsx";

const APP_NAME = "Qash";

/** The global + button: icon-only on phones, "Add entry or receipt" from 600px. Opens the chooser. */
export function AddButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="add-btn" onClick={() => setOpen(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
        <span className="add-btn__label">Add entry or receipt</span>
      </button>
      <AddChooser open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export interface ScreenHeaderProps {
  title: string;
  eyebrow?: string;
  /** A path to go back to; renders the round back button before the title. */
  back?: string;
  /** Defaults to the global add button; pass null for none. */
  actions?: ReactNode;
}

export function ScreenHeader({ title, eyebrow, back, actions }: ScreenHeaderProps) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  return (
    <header className="screen-header">
      {back ? (
        <Link to={back} className="screen-header__back" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M15 6l-6 6 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      ) : null}
      <div className="screen-header__text">
        {eyebrow ? <p className="screen-header__eyebrow">{eyebrow}</p> : null}
        <h1 className="screen-header__title">{title}</h1>
      </div>
      <div className="screen-header__actions">
        {actions === undefined ? <AddButton /> : actions}
      </div>
    </header>
  );
}
