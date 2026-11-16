import "../settings/settings.css";

import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { DocRow } from "./documentHistory.ts";

/** How many of the newest files the import screen lists before "See all". */
export const ADDED_BEFORE_SHOWN = 3;

/**
 * The files added before, on the import screen (owner feedback, November 16, 2026): the newest
 * three, numbered, each with what it became, and the way to all of them in Your documents.
 */
export function AddedBefore({ rows }: { rows: DocRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card as="section" aria-label="Added before">
      <Word>{String(rows.length)}</Word>
      <p className="doc-total__line">
        {rows.length === 1 ? "file" : "files"} added before on this device, newest first.
      </p>
      <ol className="docs-list" aria-label="Files added before">
        {rows.slice(0, ADDED_BEFORE_SHOWN).map((r, i) => (
          <li key={r.id} className="docs-list__row">
            <span className="docs-list__n">{i + 1}</span>
            <span className="docs-list__text">
              <span className="docs-list__name">{r.name}</span>
              <span className="docs-list__when">
                {r.when} · added {r.added}
              </span>
              <span className="docs-list__became">{r.became}</span>
            </span>
          </li>
        ))}
      </ol>
      <Link to="/me/documents">
        {rows.length > ADDED_BEFORE_SHOWN ? `See all ${rows.length}` : "See them"} in Your documents
      </Link>
    </Card>
  );
}
