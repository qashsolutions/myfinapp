import "../entries/entries.css";
import "../home/home.css";

import { Button, Card, List } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useLocation, useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents, formatDay } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { EntryRow } from "../entries/EntryList.tsx";
import { useTotals } from "../entries/TagScreens.tsx";
import { useLookups } from "../entries/useEntries.ts";
import { CategoryBars } from "../home/HomeVisuals.tsx";
import { entryMatches, type MatchSpec } from "./dataSearch.ts";
import { openSearch } from "./searchOpen.ts";

/**
 * Every entry a search matched, with what they add up to (search's See all, and a merchant).
 * What was searched for arrives in navigation state, never in the address: a reload sends only
 * the address, and the tab keeps the state to itself. Opened without it (a pasted link), the
 * screen offers to search again.
 */
export function MatchingEntries() {
  const { db } = useDb();
  const navigate = useNavigate();
  const lookups = useLookups();
  const state = useLocation().state as { match?: MatchSpec; title?: string } | null;
  const match = state?.match ?? null;
  const entries = useLiveQuery(
    async () =>
      match
        ? (await db.entries.filter((e) => entryMatches(e, match)).toArray()).sort(
            (a, b) => compareText(b.date, a.date) || compareText(a.id, b.id),
          )
        : [],
    [db, match],
  );
  const totals = useTotals(entries);
  const title = state?.title ?? "Search";

  if (!match)
    return (
      <>
        <ScreenHeader title="Search" actions={null} />
        <Card>
          <p>Nothing to show. Searches aren't kept, so search again.</p>
          <Button onClick={openSearch}>Search</Button>
        </Card>
      </>
    );

  return (
    <>
      <ScreenHeader title={title} eyebrow="Search" actions={null} />
      {totals ? (
        <Card as="section" aria-label="What they add up to" className="tag-total">
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
      {entries && entries.length === 0 ? (
        <Card>
          <p>No entries match now.</p>
        </Card>
      ) : (
        <List card aria-label={`Entries for ${title}`}>
          {(entries ?? []).map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              lookups={lookups}
              onOpen={() => navigate(`/entries/${e.id}`)}
            />
          ))}
        </List>
      )}
    </>
  );
}
