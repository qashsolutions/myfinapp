import "./groups.css";
import "../goals/goals.css";
import "../auth/auth.css";

import { Button, Card, ProgressBar } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { rankMembers } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useGoalProgress } from "../goals/useGoals.ts";
import { GroupInvite } from "./GroupInvite.tsx";
import { Leaderboard } from "./Leaderboard.tsx";
import { leaveGroup, removeMember, useGroup, useGroupGoal } from "./useGroups.ts";
import { WhatHelped } from "./WhatHelped.tsx";

/** One challenge (mockup F4Challenge): my private progress, the leaderboard, invite, leave. */
export function ChallengeDetail() {
  const { id } = useParams();
  const { db } = useDb();
  const navigate = useNavigate();
  const today = todayIso();
  const { group, error, refresh, accept } = useGroup(id);
  const goal = useGroupGoal(id);
  const view = useGoalProgress(goal ?? null, today);
  const [invite, setInvite] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [myRank, setMyRank] = useState<number | null>(null);

  useEffect(() => {
    if (!group) return;
    let alive = true;
    void rankMembers(
      group.members.map((m) => ({
        id: m.user_id,
        progress_bps: m.progress_bps,
        reached_at: m.reached_at,
        has_events: m.has_events,
      })),
    ).then((r) => {
      if (!alive) return;
      const me = group.members.find((m) => m.is_me);
      setMyRank(r.ranked.find((x) => x.id === me?.user_id)?.rank ?? null);
    });
    return () => {
      alive = false;
    };
  }, [group]);

  // My own percentage changes when I log a deposit; show the board with it straight away.
  const myBps = view?.progress?.progress_bps ?? null;
  useEffect(() => {
    if (myBps === null) return;
    void refresh();
  }, [myBps, refresh]);

  if (error?.status === 404) {
    return (
      <>
        <ScreenHeader title="Challenge" actions={null} back="/goals" />
        <Card>
          <p>You're not in this group any more.</p>
        </Card>
      </>
    );
  }
  if (!group) {
    return (
      <>
        <ScreenHeader title="Challenge" actions={null} back="/goals" />
        <p className="sr-only" role="status">
          Loading
        </p>
        {error ? (
          <Card>
            <p>Couldn't reach the server. Try again when you're online.</p>
          </Card>
        ) : null}
      </>
    );
  }
  const p = view?.progress ?? null;
  // Past its last day (invariant 56): the final board, and nothing more to log or invite to.
  const ended = compareText(group.end_date, today) < 0;
  // Before its first day nothing counts yet (invariant 71).
  const notStarted = compareText(group.start_date, today) > 0;
  // The result is final once the server says it is over everywhere (invariant 71): leaving
  // then keeps my standing on the board, and nobody can be removed from it.
  const final = group.result_final;

  return (
    <>
      <ScreenHeader
        title={group.name}
        back="/goals"
        actions={
          ended ? null : (
            <Button size="sm" variant="secondary" onClick={() => setInvite(true)}>
              Invite
            </Button>
          )
        }
      />
      <Card tone="accent" as="section" aria-label="Your progress">
        <div className="hero-split">
          <span className="sk-card__eyebrow">
            Group · {group.member_count} {group.member_count === 1 ? "person" : "people"} ·{" "}
            {ended ? "ended" : "ends"} {formatDay(group.end_date)}
          </span>
          <span className="sk-card__eyebrow">You: {myRank === null ? "–" : `#${myRank}`}</span>
        </div>
        {ended ? (
          <Word>Ended</Word>
        ) : goal ? (
          <Word>
            {!p || p.current <= 0 ? "Start" : p.display_bps >= 10000 ? "Reached" : "Saving"}
          </Word>
        ) : null}
        {goal ? (
          <>
            <p className="sk-card__hero">
              {p ? (
                <>
                  {goal.kind === "habit"
                    ? p.current
                    : formatCents(
                        goal.kind === "spend_less" ? Math.max(0, p.current) : p.current,
                      )}{" "}
                  <span className="sk-card__hero-unit">
                    {goal.kind === "habit"
                      ? `of ${p.target} days`
                      : goal.kind === "spend_less"
                        ? `kept back of ${formatCents(p.target)}`
                        : `of ${formatCents(p.target)}`}
                  </span>
                </>
              ) : (
                ""
              )}
            </p>
            <ProgressBar
              fraction={p ? p.display_bps / 10000 : 0}
              label="Your progress"
              valueText={p ? `${Math.round(p.display_bps / 100)}% of your target` : ""}
            />
            {ended ? (
              <p>
                {p && p.display_bps >= 10000
                  ? "You reached your target. Here's how everyone finished."
                  : "Here's how everyone finished."}
              </p>
            ) : notStarted ? (
              <p>Starts {formatDay(group.start_date)}. Log from then.</p>
            ) : (
              <Link to={`/goals/${goal.id}`} className="auth__link" style={{ color: "inherit" }}>
                {goal.kind === "habit"
                  ? "Check in for today"
                  : goal.kind === "spend_less"
                    ? "See this month's dining"
                    : "Log a deposit"}
              </Link>
            )}
          </>
        ) : goal === null ? (
          <p>Your target for this challenge lives on the device you joined from.</p>
        ) : null}
      </Card>
      <Card as="section" aria-label={ended ? "Final leaderboard" : "Leaderboard"}>
        {ended ? <h2 className="sk-card__title">Final leaderboard</h2> : null}
        <Leaderboard
          members={group.members}
          isOwner={group.is_owner && !final}
          onRemove={async (m) => {
            await removeMember(group.id, m.user_id);
            await refresh();
          }}
        />
      </Card>
      {group.helped_open ? <WhatHelped group={group} onSaved={accept} /> : null}
      <p className="auth__fineprint">
        Members see your name and % only, never your dollars. Your target and deposits stay on this
        device.
      </p>
      {!group.is_owner ? (
        <Button
          variant="ghost"
          block
          onClick={async () => {
            if (!confirmLeave) {
              setConfirmLeave(true);
              return;
            }
            await leaveGroup(db, group.id);
            navigate("/goals", { replace: true });
          }}
        >
          <span style={{ color: "var(--c-danger)" }}>
            {final
              ? confirmLeave
                ? "Really remove it from my list"
                : "Remove from my list"
              : confirmLeave
                ? "Really leave this group"
                : "Leave group"}
          </span>
        </Button>
      ) : null}
      {!group.is_owner && final ? (
        <p className="auth__fineprint">Your result stays on the final board for everyone.</p>
      ) : null}
      <GroupInvite
        group={group}
        open={invite}
        onClose={() => setInvite(false)}
        onChanged={refresh}
      />
    </>
  );
}
