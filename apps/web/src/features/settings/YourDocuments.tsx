import "../auth/auth.css";
import "./settings.css";

import { Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { daysUntil } from "../../engine/bridge.ts";
import { maskFileName } from "../../importers/masking.ts";
import { dayOf, formatCents, formatDate, formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { GROUP_LABEL, STALE_DAYS } from "../networth/useNetWorth.ts";

/** One file in the list: a statement imported, or a document whose total went to Net worth. */
interface DocRow {
  id: string;
  name: string;
  /** The date or dates the document gives. */
  when: string;
  added: string;
  became: string;
  /** Days since a total's date, when it is past the update nudge. */
  oldDays: number | null;
}

/**
 * Your documents (owner decision, November 16, 2026): every file added, newest first and
 * numbered, with the date the document gives, the day it was added and what it became. Only
 * the masked name and those facts are kept, on this device.
 */
export function YourDocuments() {
  const { db } = useDb();
  const today = todayIso();
  const rows = useLiveQuery(async (): Promise<DocRow[]> => {
    const [statements, totals, accounts] = await Promise.all([
      db.statement_imports.toArray(),
      db.document_imports.toArray(),
      db.accounts.toArray(),
    ]);
    const account = new Map(accounts.map((a) => [a.id, a]));
    const out: Array<DocRow & { at: string }> = [];
    for (const s of statements) {
      const a = account.get(s.account_id);
      const where = a ? `${a.label}${a.last4 ? ` ••${a.last4}` : ""}` : "An account removed since";
      out.push({
        id: `statement:${s.id}`,
        at: s.created_at,
        name: maskFileName(s.file_name),
        when:
          s.period_start && s.period_end
            ? `${formatDate(s.period_start)} – ${formatDate(s.period_end)}`
            : s.period_end
              ? `To ${formatDate(s.period_end)}`
              : "Dates not given",
        added: formatDay(dayOf(s.created_at)),
        became: `${where} · ${s.rows_added} ${s.rows_added === 1 ? "transaction" : "transactions"}`,
        oldDays: null,
      });
    }
    for (const d of totals) {
      // Whole days from the document's date to today (dates.days_until).
      const age = d.as_of ? await daysUntil(d.as_of, today) : null;
      out.push({
        id: `document:${d.id}`,
        at: d.created_at,
        name: maskFileName(d.file_name),
        when: d.as_of ? formatDate(d.as_of) : "Date not given",
        added: formatDay(dayOf(d.created_at)),
        became: `Net worth · ${d.label} · ${formatCents(d.cents)}${d.kind === "debt" ? " owed" : ""} · ${GROUP_LABEL[d.group] ?? d.group}`,
        oldDays: age !== null && age > STALE_DAYS ? age : null,
      });
    }
    return out
      .sort((a, b) => compareText(b.at, a.at) || compareText(a.id, b.id))
      .map(({ at: _at, ...r }) => r);
  }, [db, today]);

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
