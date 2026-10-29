import "./groups.css";
import "../goals/goals.css";
import "../auth/auth.css";

import { buttonClass, Card, Illustration, ProgressBar } from "@stackd/ui";
import { Link } from "react-router";
import type { GroupSummary } from "../../data/api.ts";
import { formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { useGroups } from "./useGroups.ts";

export function percentText(bps: number): string {
  return `${Math.round(Math.min(bps, 10000) / 100)}%`;
}

function ChallengeCard({ g, ended }: { g: GroupSummary; ended: boolean }) {
  return (
    <Link to={`/groups/${g.id}`} className="card-link" aria-label={g.name}>
      <Card as="article">
        <div className="goal-card__top">
          <span className="goal-card__title">{g.name}</span>
          <span className="lb__pct">{percentText(g.my_progress_bps)}</span>
        </div>
        <p className="group-row__meta">
          {g.member_count} {g.member_count === 1 ? "person" : "people"} · {ended ? "ended" : "ends"}{" "}
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
  );
}

/**
 * The Challenges half of the Goals tab: my groups, start one, join one. Challenges past their last
 * day fold into Ended (invariant 56): their final boards stay a tap away and their jars no
 * longer hold a place on the plan.
 */
export function ChallengesTab() {
  const { groups, error } = useGroups();
  const { entitlements } = useEntitlements();
  const today = todayIso();
  const isEnded = (g: GroupSummary) => compareText(g.end_date, today) < 0;
  const running = (groups ?? []).filter((g) => !isEnded(g));
  const ended = (groups ?? []).filter(isEnded);
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
      {running.map((g) => (
        <ChallengeCard key={g.id} g={g} ended={false} />
      ))}
      {ended.length > 0 ? (
        <details className="jar-group">
          <summary className="jar-group__summary">Ended · {ended.length}</summary>
          {ended.map((g) => (
            <ChallengeCard key={g.id} g={g} ended />
          ))}
        </details>
      ) : null}
    </>
  );
}
