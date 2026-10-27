import { Button, Chip, ProgressBar } from "@stackd/ui";
import { useEffect, useState } from "react";
import type { GroupMemberOut } from "../../data/api.ts";
import { type Ranking, rankMembers } from "../../engine/bridge.ts";
import { percentText } from "./ChallengesTab.tsx";

/**
 * Rank, initial, name, bar, percent (mockup F4Challenge). Order comes from the `groups.rank`
 * rule; members with nothing logged yet are listed underneath, unranked.
 */
export function Leaderboard({
  members,
  isOwner,
  onRemove,
}: {
  members: GroupMemberOut[];
  isOwner: boolean;
  onRemove?: (member: GroupMemberOut) => Promise<void>;
}) {
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void rankMembers(
      members.map((m) => ({
        id: m.user_id,
        progress_bps: m.progress_bps,
        reached_at: m.reached_at,
        has_events: m.has_events,
      })),
    ).then((r) => {
      if (alive) setRanking(r);
    });
    return () => {
      alive = false;
    };
  }, [members]);
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const hidden = (ranking?.hidden ?? []).map((id) => byId.get(id)).filter((m) => m !== undefined);
  return (
    <>
      <div className="hero-split">
        <h2 className="sk-card__title">Leaderboard</h2>
        <span className="group-row__meta">% of each person's own goal</span>
      </div>
      {ranking && ranking.ranked.length === 0 ? (
        <p className="group-row__meta">
          Nobody has logged a deposit yet. The first one starts the board.
        </p>
      ) : null}
      <ol className="lb" aria-label="Leaderboard">
        {ranking?.ranked.map((r) => {
          const m = byId.get(r.id);
          if (!m) return null;
          return (
            <li className="lb__row" key={r.id} aria-current={m.is_me ? "true" : undefined}>
              <span className="lb__rank">{r.rank}</span>
              <span className="lb__avatar" aria-hidden="true">
                {m.initial}
              </span>
              <span className="lb__name">
                <span>{m.is_me ? "You" : m.display_name}</span>
                {m.is_owner ? <Chip tone="neutral">Owner</Chip> : null}
                <ProgressBar
                  fraction={Math.min(1, r.progress_bps / 10000)}
                  label={`${m.is_me ? "Your" : `${m.display_name}'s`} progress`}
                  valueText={percentText(r.progress_bps)}
                />
              </span>
              <span className="lb__pct">{percentText(r.progress_bps)}</span>
              {isOwner && !m.is_me && onRemove ? (
                <span className="lb__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (confirm !== m.user_id) {
                        setConfirm(m.user_id);
                        return;
                      }
                      await onRemove(m);
                      setConfirm(null);
                    }}
                  >
                    {confirm === m.user_id ? `Really remove ${m.display_name}` : "Remove"}
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {hidden.length > 0 ? (
        <p className="group-row__meta">
          Not on the board yet: {hidden.map((m) => (m.is_me ? "you" : m.display_name)).join(", ")}
        </p>
      ) : null}
    </>
  );
}
