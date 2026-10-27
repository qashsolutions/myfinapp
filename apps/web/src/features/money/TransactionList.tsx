import { Card, Illustration, List } from "@stackd/ui";
import { useNavigate } from "react-router";
import type { Entry } from "../../data/db.ts";
import { formatDay } from "../../lib/format.ts";
import { EntryRow, groupByDay } from "../entries/EntryList.tsx";
import type { Lookups } from "../entries/useEntries.ts";

/** Every entry in the month, grouped by day, newest first (your entries live here since October 23, 2026). */
export function TransactionList({
  entries,
  lookups,
}: {
  entries: Entry[];
  lookups: Lookups | undefined;
}) {
  const navigate = useNavigate();
  if (entries.length === 0) {
    return (
      <Card>
        <Illustration name="receipt" tone="a1" />
        <p>No entries this month. Tap + to add one.</p>
      </Card>
    );
  }
  return (
    <section aria-label="Transactions">
      {groupByDay(entries).map(([day, rows]) => (
        <section key={day} aria-label={formatDay(day)}>
          <p className="entries-day">{formatDay(day)}</p>
          <List card>
            {rows.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                lookups={lookups}
                onOpen={() => navigate(`/entries/${e.id}`)}
              />
            ))}
          </List>
        </section>
      ))}
    </section>
  );
}
