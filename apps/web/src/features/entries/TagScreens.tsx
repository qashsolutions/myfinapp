import "./entries.css";
import "../home/home.css";

import { Card, List, ListRow } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Entry } from "../../data/db.ts";
import { counted } from "../../data/db.ts";
import { type MonthTotals, periodTotals } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { CategoryBars } from "../home/HomeVisuals.tsx";
import { toRuleEntry } from "../money/ruleEntries.ts";
import { EntryRow } from "./EntryList.tsx";
import { useLookups } from "./useEntries.ts";

/** The totals for a set of entries, from their first to their last date (cashflow.period_totals). */
function useTotals(entries: Entry[] | undefined): MonthTotals | null {
  const lookups = useLookups();
  const [totals, setTotals] = useState<MonthTotals | null>(null);
  useEffect(() => {
    if (!entries || !lookups) return;
    if (entries.length === 0) return setTotals(null);
    let alive = true;
    const dates = entries.map((e) => e.date).sort();
    void periodTotals(
      dates[0] ?? "",
      dates[dates.length - 1] ?? "",
      counted(entries).map((e) => toRuleEntry(e, lookups.categories)),
    ).then((t) => {
      if (alive) setTotals(t);
    });
    return () => {
      alive = false;
    };
  }, [entries, lookups]);
  return totals;
}

/** Every tag with how many entries carry it, most used first (from Money in & out). */
export function TagsScreen() {
  const { db } = useDb();
  const navigate = useNavigate();
  const counts = useLiveQuery(async () => {
    const out = new Map<string, number>();
    await db.entries
      .where("tags")
      .notEqual("")
      .each((e) => {
        for (const t of e.tags ?? []) out.set(t, (out.get(t) ?? 0) + 1);
      });
    return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [db]);
  return (
    <>
      <ScreenHeader title="Tags" back="/money" actions={null} />
      {counts && counts.length === 0 ? (
        <Card>
          <p className="entries-empty">
            No tags yet. Open an entry and add one, like “Hawaii trip”, to see it across categories.
          </p>
        </Card>
      ) : (
        <List card aria-label="Your tags">
          {(counts ?? []).map(([tag, n]) => (
            <ListRow
              key={tag}
              label={`#${tag}`}
              sublabel={n === 1 ? "1 entry" : `${n} entries`}
              href={`/tags/${encodeURIComponent(tag)}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/tags/${encodeURIComponent(tag)}`);
              }}
            />
          ))}
        </List>
      )}
    </>
  );
}

/** One tag: what it cost in all, where it went by category, and its entries. */
export function TagDetail() {
  const { tag = "" } = useParams();
  const { db } = useDb();
  const navigate = useNavigate();
  const lookups = useLookups();
  const entries = useLiveQuery(
    () => db.entries.where("tags").equalsIgnoreCase(tag).reverse().sortBy("date"),
    [db, tag],
  );
  const totals = useTotals(entries);
  return (
    <>
      <ScreenHeader title={`#${tag}`} back="/tags" actions={null} />
      {totals ? (
        <Card as="section" aria-label={`#${tag} in all`} className="tag-total">
          <p className="sk-card__eyebrow">
            {formatDay(totals.start)}
            {totals.end !== totals.start ? ` – ${formatDay(totals.end)}` : ""}
          </p>
          <p className="home__big">
            {formatCents(totals.out_cents)}
            <span className="home__big-unit"> spent</span>
          </p>
          {totals.in_cents > 0 ? (
            <p className="sk-card__eyebrow">{formatCents(totals.in_cents)} came in</p>
          ) : null}
          <CategoryBars byCategory={totals.by_category} categories={lookups?.categories} />
        </Card>
      ) : null}
      <List card aria-label={`Entries tagged ${tag}`}>
        {(entries ?? []).map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            lookups={lookups}
            onOpen={() => navigate(`/entries/${e.id}`)}
          />
        ))}
      </List>
    </>
  );
}
