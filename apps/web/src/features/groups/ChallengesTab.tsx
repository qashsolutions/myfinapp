import "./groups.css";
import "../auth/auth.css";

import { buttonClass, Card, Illustration, ProgressBar } from "@stackd/ui";
import { Link } from "react-router";
import { formatDay } from "../../lib/format.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { useGroups } from "./useGroups.ts";

export function percentText(bps: number): string {
  return `${Math.round(Math.min(bps, 10000) / 100)}%`;
}

/** The Challenges half of the Goals tab: my groups, start one, join one. */
export function ChallengesTab() {
  const { groups, error } = useGroups();
  const { entitlements } = useEntitlements();
  return (
    <>
      <div className="group-actions">
        <Link to="/groups/new" className={buttonClass({ block: true })}>
          Start a challenge
        </Link>
        <Link to="/groups/join" className={buttonClass({ variant: "secondary", block: true })}>
          Join with a code
        </Link>
      </div>
      {!entitlements.groups_create ? (
        <p className="sk-card__eyebrow">
          Joining a challenge is on every plan ; starting one needs Private or Connected.{" "}
          <Link to="/me/plan" className="auth__link">
            See plans
          </Link>
        </p>
      ) : null}
      {groups === null && !error ? (
        <p className="sk-card__eyebrow" role="status">
          Loading challenges…
        </p>
      ) : null}
      {error ? (
        <Card>
          <p>Couldn't reach the server. Your challenges are still there; try again when online.</p>
        </Card>
      ) : null}
      {groups?.length === 0 ? (
        <Card>
          <Illustration name="friends" tone="a3" />
          <p>
            No challenges yet. Start one and share the code, or join a friend's. Everyone saves
            toward their own target; the group only ever sees percentages.
          </p>
        </Card>
      ) : null}
      {groups?.map((g) => (
        <Link key={g.id} to={`/groups/${g.id}`} className="card-link" aria-label={g.name}>
          <Card as="article">
            <div className="goal-card__top">
              <span className="goal-card__title">{g.name}</span>
              <span className="lb__pct">{percentText(g.my_progress_bps)}</span>
            </div>
            <p className="group-row__meta">
              {g.member_count} {g.member_count === 1 ? "person" : "people"} · ends{" "}
              {formatDay(g.end_date)}
              {g.is_owner ? " · you started it" : ""}
            </p>
            <ProgressBar
              fraction={Math.min(1, g.my_progress_bps / 10000)}
              label={`${g.name}: your progress`}
              valueText={`${percentText(g.my_progress_bps)} of your target`}
            />
          </Card>
        </Link>
      ))}
    </>
  );
}
