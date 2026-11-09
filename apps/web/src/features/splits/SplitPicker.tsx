import "./splits.css";

import { buttonClass, Card, List, ListRow } from "@stackd/ui";
import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useSplits, useSplitViews } from "./useSplits.ts";

/**
 * "A split" from the + button, or "Share it in a split group" on an entry: which group? With one
 * group it goes straight to Add a bill; with none, to New group (or the trial line for guests).
 */
export function SplitPicker() {
  const [params] = useSearchParams();
  const entry = params.get("entry");
  const navigate = useNavigate();
  const { splits, error } = useSplits();
  const groups = (splits?.groups ?? []).filter(
    (g) => g.writable && (g.is_organizer || g.guests_can_add),
  );
  const views = useSplitViews(splits ? groups : null);
  const suffix = entry ? `?entry=${encodeURIComponent(entry)}` : "";
  const only = splits && groups.length === 1 ? groups[0] : null;
  useEffect(() => {
    if (only) navigate(`/splits/${only.id}/bills/new${suffix}`, { replace: true });
  }, [only, navigate, suffix]);
  return (
    <>
      <ScreenHeader title="Add a split" actions={null} back={entry ? `/entries/${entry}` : "/"} />
      {!splits ? (
        error ? (
          <Card>
            <p>Couldn't reach the server. Try again when you're online.</p>
          </Card>
        ) : (
          <p className="sr-only" role="status">
            Loading
          </p>
        )
      ) : groups.length === 0 ? (
        <Card>
          <p>No group to add it to yet.</p>
          {splits.can_create ? (
            <Link to="/splits/new" className={buttonClass({ block: true })}>
              Start a group
            </Link>
          ) : (
            <p className="auth__fineprint">
              Want your own groups? <Link to="/me/plan">Try Qash free for 3 days.</Link>
            </p>
          )}
        </Card>
      ) : (
        <List card aria-label="Pick a group">
          {groups.map((g) => (
            <ListRow
              key={g.id}
              href={`/splits/${g.id}/bills/new${suffix}`}
              label={views.get(g.id)?.merged.group?.name ?? "Group"}
              sublabel={`${g.members.length} ${g.members.length === 1 ? "person" : "people"}`}
            />
          ))}
        </List>
      )}
    </>
  );
}
