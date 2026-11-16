import "../auth/auth.css";
import "./settings.css";

import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDocumentHistory } from "../imports/documentHistory.ts";

/**
 * Your documents (owner decision, November 16, 2026): every file added, newest first and
 * numbered, with the date the document gives, the day it was added and what it became. Only
 * the masked name and those facts are kept, on this device.
 */
export function YourDocuments() {
  const rows = useDocumentHistory();

  return (
    <>
      <ScreenHeader title="Your documents" actions={null} back="/me/data" />
      {rows && rows.length === 0 ? (
        <Card>
          <Word>None</Word>
          <p>Statements and documents you add show here, newest first.</p>
          <p>
            <Link to="/import">Add statements &amp; documents</Link>
          </p>
        </Card>
      ) : rows ? (
        <>
          <Card>
            <Word>{String(rows.length)}</Word>
            <p>
              {rows.length === 1 ? "file" : "files"} added, newest first. Each says what it became.
            </p>
          </Card>
          <ol className="docs-list" aria-label="Files added">
            {rows.map((r, i) => (
              <li key={r.id} className="docs-list__row">
                <span className="docs-list__n">{i + 1}</span>
                <span className="docs-list__text">
                  <span className="docs-list__name">{r.name}</span>
                  <span className="docs-list__when">
                    {r.when} · added {r.added}
                  </span>
                  <span className="docs-list__became">{r.became}</span>
                  {r.oldDays !== null ? (
                    <Link to="/import" className="docs-list__old">
                      {r.oldDays} days old · Update with a newer one
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <p className="auth__fineprint">
            The first date is the one the document gives, the second the day it was added. Only
            names and these facts are kept, on this device; long numbers in a name show as ••4821.
          </p>
        </>
      ) : null}
    </>
  );
}
