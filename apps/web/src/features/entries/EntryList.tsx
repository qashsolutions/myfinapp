import "./entries.css";

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useDb } from "../../data/DbProvider.tsx";
import type { Entry } from "../../data/db.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { duplicateOf, setCounted } from "./entryActions.ts";
import { RenameSheet } from "./RenameSheet.tsx";
import { showUndo } from "./undoToast.ts";
import { accountLabel, type Lookups } from "./useEntries.ts";

const ACTIONS_WIDTH = 216;

/**
 * One entry. Swipe left (or drag with a mouse) for Rename and Don't count, plus "Duplicate?"
 * when another entry has the same date, amount and direction. Both actions are also in the
 * entry editor, for keyboards and screen readers (October 20, 2026).
 */
export function EntryRow({
  entry,
  lookups,
  onOpen,
  withDate = false,
}: {
  entry: Entry;
  lookups: Lookups | undefined;
  onOpen: () => void;
  withDate?: boolean;
}) {
  const { db } = useDb();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dup, setDup] = useState<Entry | null>(null);
  const drag = useRef<{ x: number; y: number; base: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void duplicateOf(db, entry).then((d) => {
      if (alive) setDup(d);
    });
    return () => {
      alive = false;
    };
  }, [open, db, entry]);

  const category = entry.category_id ? lookups?.categories.get(entry.category_id)?.name : null;
  const account = accountLabel(lookups?.accounts.get(entry.account_id));
  const tags = (entry.tags ?? []).map((t) => `#${t}`).join(" ");
  const note = entry.note
    ? `“${entry.note.length > 40 ? `${entry.note.slice(0, 40)}…` : entry.note}”`
    : "";
  const sub = [
    withDate ? formatDay(entry.date) : null,
    account,
    entry.is_transfer ? "Transfer" : (category ?? (withDate ? "Uncategorized" : null)),
    entry.not_counted ? "Not counted" : null,
    tags,
    note,
  ]
    .filter(Boolean)
    .join(" · ");

  function settle(to: boolean) {
    setOpen(to);
    setOffset(to ? -ACTIONS_WIDTH : 0);
  }

  async function toggleCounted() {
    const nowCounted = Boolean(entry.not_counted);
    await setCounted(db, entry.id, nowCounted);
    settle(false);
    showUndo(
      nowCounted ? "Counted in spending again" : "Not counted in spending",
      () => void setCounted(db, entry.id, !nowCounted),
    );
  }

  const hidden = !open;
  return (
    <li
      className={`sk-list__item swipe${entry.not_counted ? " swipe--off" : ""}${open ? " swipe--open" : ""}`}
    >
      <div className="swipe__actions" aria-hidden={hidden}>
        {dup ? (
          <button
            type="button"
            className="swipe__action swipe__action--dup"
            tabIndex={hidden ? -1 : 0}
            onClick={() => navigate(`/entries/${entry.id}?duplicate=${dup.id}`)}
          >
            Duplicate?
          </button>
        ) : null}
        <button
          type="button"
          className="swipe__action"
          tabIndex={hidden ? -1 : 0}
          onClick={() => {
            settle(false);
            setRenaming(true);
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="swipe__action swipe__action--count"
          tabIndex={hidden ? -1 : 0}
          onClick={() => void toggleCounted()}
        >
          {entry.not_counted ? "Count" : "Don't count"}
        </button>
      </div>
      <button
        type="button"
        className="sk-row sk-row--interactive swipe__row"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
        onPointerDown={(e) => {
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            base: open ? -ACTIONS_WIDTH : 0,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - d.y)) {
            d.moved = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }
          if (d.moved) setOffset(Math.max(-ACTIONS_WIDTH, Math.min(0, d.base + dx)));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) {
            swallowClick.current = true;
            settle(offset < -ACTIONS_WIDTH / 2);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          settle(open);
        }}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false;
            return;
          }
          if (open) return settle(false);
          onOpen();
        }}
      >
        <span className="sk-row__text">
          <span className="sk-row__label">{entry.merchant}</span>
          {sub ? <span className="sk-row__sublabel">{sub}</span> : null}
        </span>
        <span className={`sk-row__value sk-row__value--${entry.is_transfer ? "sub" : "default"}`}>
          <span
            className={`entry-amount${entry.direction === "in" && !entry.is_transfer ? " entry-amount--in" : ""}`}
          >
            {formatCents(entry.amount_cents, entry.direction)}
          </span>
        </span>
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
      </button>
      {renaming ? <RenameSheet entry={entry} onClose={() => setRenaming(false)} /> : null}
    </li>
  );
}

export function groupByDay(entries: Entry[]): Array<[string, Entry[]]> {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = map.get(e.date) ?? [];
    list.push(e);
    map.set(e.date, list);
  }
  return [...map.entries()];
}
