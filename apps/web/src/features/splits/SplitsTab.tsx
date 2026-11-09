import "./splits.css";

import { buttonClass, Card, List, ListRow } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { formatCents } from "../../lib/format.ts";
import { myBalance, useSplits, useSplitViews } from "./useSplits.ts";

/** "+$68" / "−$18" / "Settled": what one group means for me. */
export function balanceText(cents: number): string {
  if (cents > 0) return `+${formatCents(cents)}`;
  if (cents < 0) return `−${formatCents(-cents)}`;
  return "Settled";
}

/**
 * Goals → Splits (chunk S.3b, canvas "Splits tab"): every group I'm in with my balance, the
 * total first. Group names come from the organizer's encrypted ledger; a group whose key hasn't
 * reached this device yet reads "Waiting for the key".
 */
export function SplitsTab() {
  const { splits, error } = useSplits();
  const views = useSplitViews(splits?.groups ?? null);
  if (!splits) {
    return error ? (
      <Card>
        <p>Couldn't reach the server. Try again when you're online.</p>
      </Card>
    ) : (
      <p className="sr-only" role="status">
        Loading
      </p>
    );
  }
  const total = splits.groups.reduce((sum, g) => sum + myBalance(views.get(g.id), g), 0);
  const word = total > 0 ? "Owed" : total < 0 ? "Owe" : "Clear";
  return (
    <>
      {splits.groups.length > 0 ? (
        <Card as="section" aria-label="Your balance across groups">
          <Word>{word}</Word>
          <p className="sk-card__hero">
            {total === 0 ? "Settled" : formatCents(Math.abs(total))}
            {total === 0 ? null : (
              <span className="sk-card__hero-unit">{total > 0 ? " owed to you" : " you owe"}</span>
            )}
          </p>
          <p>
            Across {splits.groups.length} {splits.groups.length === 1 ? "group" : "groups"}.
          </p>
        </Card>
      ) : null}
      {splits.blocked ? (
        <Card role="status">
          <Word>Paused</Word>
          <p>Reports have paused your groups. Support can look at it.</p>
        </Card>
      ) : null}
      {splits.groups.length === 0 ? (
        <Card>
          <p>
            Split rent, trips and dinners with anyone. They join free by email; you see who owes
            what.
          </p>
        </Card>
      ) : (
        <List card aria-label="Your split groups">
          {splits.groups.map((g) => {
            const view = views.get(g.id);
            const cents = myBalance(view, g);
            const name =
              view?.merged.group?.name ?? (view && !view.hasKey ? "Waiting for the key" : "Group");
            return (
              <ListRow
                key={g.id}
                href={`/splits/${g.id}`}
                label={name}
                sublabel={`${g.members.length} ${g.members.length === 1 ? "person" : "people"}${
                  g.is_organizer ? " · You run it" : ""
                }`}
                value={balanceText(cents)}
                valueTone={cents > 0 ? "success" : cents < 0 ? "danger" : "sub"}
              />
            );
          })}
        </List>
      )}
      {splits.can_create ? (
        <Link to="/splits/new" className={buttonClass({ block: true, variant: "secondary" })}>
          + New group
        </Link>
      ) : splits.guest ? (
        <p className="auth__fineprint">
          Want your own groups? <Link to="/me/plan">Try Qash free for 3 days.</Link>
        </p>
      ) : null}
      <p className="auth__fineprint">
        Qash never moves money. Bills and names are encrypted on this device before they leave.
      </p>
    </>
  );
}
