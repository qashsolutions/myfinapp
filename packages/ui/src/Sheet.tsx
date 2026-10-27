import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.ts";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * A bottom sheet on phones, a centred dialog from 600px. Modal: Escape and the backdrop
 * close it, focus moves in on open and back out on close.
 */
export function Sheet({ open, onClose, title, children, className }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);
  // Latest onClose without re-running the focus effect: callers pass inline closures, and
  // re-focusing the first control on every render would steal focus from an input mid-typing.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>("button, [href], input, [tabindex]");
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="sk-sheet__backdrop">
      <div className="sk-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        className={cx("sk-sheet", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        tabIndex={-1}
      >
        <span className="sk-sheet__handle" aria-hidden="true" />
        <h2 className="sk-sheet__title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
