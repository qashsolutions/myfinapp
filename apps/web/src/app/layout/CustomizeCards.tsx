import "./customize.css";

import { Button, Sheet, Toggle } from "@stackd/ui";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type CardLayout, type CardSpec, moveCard, saveCardLayout } from "./cardLayout.ts";

/**
 * Customize a screen's cards (Customize Home, October 19, 2026; any screen since October 25,
 * 2026): drag a card by its handle into place, or use Move up / Move down (keyboard, screen
 * readers), and switch any card off. Saved at once.
 */
export function CustomizeCards<Id extends string>({
  screen,
  title,
  listLabel,
  cards,
  open,
  onClose,
  layout,
  note,
}: {
  screen: string;
  title: string;
  listLabel: string;
  cards: readonly CardSpec<Id>[];
  open: boolean;
  onClose: () => void;
  layout: CardLayout<Id>;
  note?: ReactNode;
}) {
  const { db } = useDb();
  const infoOf = new Map(cards.map(([id, t, line]) => [id, { title: t, line }]));
  const defaults = cards.map(([id]) => id);
  const list = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<Id | null>(null);
  const [said, setSaid] = useState("");
  // While the sheet is open it edits its own copy, taken when it opens: each quick tap builds on
  // the one before, never on a saved copy still on its way back (October 20, 2026).
  const [local, setLocal] = useState(layout);
  const latest = useRef(layout);
  // biome-ignore lint/correctness/useExhaustiveDependencies: take the saved layout only on opening
  useEffect(() => {
    if (!open) return;
    setLocal(layout);
    latest.current = layout;
  }, [open]);

  async function save(next: CardLayout<Id>) {
    latest.current = next;
    setLocal(next);
    await saveCardLayout(db, screen, next);
  }

  function move(id: Id, by: number) {
    const now = latest.current;
    const from = now.order.indexOf(id);
    const to = from + by;
    if (to < 0 || to >= now.order.length) return;
    void save({ ...now, order: moveCard(now.order, from, to) });
    setSaid(`${infoOf.get(id)?.title} moved to ${to + 1} of ${now.order.length}`);
  }

  // Dragging by the handle: follow the pointer and drop the card where it is over another row.
  function startDrag(e: PointerEvent<HTMLButtonElement>, id: Id) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
  }
  function dragOver(e: PointerEvent<HTMLButtonElement>, id: Id) {
    if (dragging !== id || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>("[data-card]")];
    const over = rows.findIndex((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY <= box.bottom;
    });
    const now = latest.current;
    const from = now.order.indexOf(id);
    if (over >= 0 && over !== from) void save({ ...now, order: moveCard(now.order, from, over) });
  }
  function endDrag(id: Id) {
    if (dragging === id) {
      setSaid(
        `${infoOf.get(id)?.title} is now ${latest.current.order.indexOf(id) + 1} of ${latest.current.order.length}`,
      );
      setDragging(null);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="auth__hint">Drag a card into place, or switch it off. Saved as you go.</p>
      <ol ref={list} className="customize" aria-label={listLabel}>
        {local.order.map((id, i) => {
          const info = infoOf.get(id);
          const shown = !local.hidden.includes(id);
          return (
            <li
              key={id}
              data-card={id}
              className={`customize__row${dragging === id ? " customize__row--dragging" : ""}${shown ? "" : " customize__row--off"}`}
            >
              <button
                type="button"
                className="customize__handle"
                aria-label={`Drag ${info?.title}`}
                onPointerDown={(e) => startDrag(e, id)}
                onPointerMove={(e) => dragOver(e, id)}
                onPointerUp={() => endDrag(id)}
                onPointerCancel={() => endDrag(id)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01"
                    stroke="currentColor"
                    strokeWidth="3.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <Toggle
                className="customize__toggle"
                checked={shown}
                label={info?.title ?? id}
                description={info?.line}
                onChange={(on) => {
                  const now = latest.current;
                  void save({
                    ...now,
                    hidden: on ? now.hidden.filter((h) => h !== id) : [...now.hidden, id],
                  });
                }}
              />
              <span className="customize__moves">
                <button
                  type="button"
                  className="customize__move"
                  aria-label={`Move ${info?.title} up`}
                  disabled={i === 0}
                  onClick={() => move(id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="customize__move"
                  aria-label={`Move ${info?.title} down`}
                  disabled={i === local.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status">
        {said}
      </p>
      {note ? <p className="auth__fineprint">{note}</p> : null}
      <Button
        variant="secondary"
        block
        onClick={() => {
          void save({ order: [...defaults], hidden: [] });
          setSaid("Back to the usual order");
        }}
      >
        Reset to the usual order
      </Button>
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}
