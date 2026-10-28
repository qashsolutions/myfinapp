/** Port of stackd_rules/groups.py: the leaderboard order. */

import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";
import { compareText } from "./text.ts";

const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export interface RankedMember {
  id: string;
  rank: number;
  progress_bps: number;
  reached_at: string | null;
}

export interface Ranking {
  ranked: RankedMember[];
  hidden: string[];
}

interface Row {
  id: string;
  progress: number;
  reached: string | null;
  hasEvents: boolean;
  order: number;
}

export function rank(members: unknown): Ranking {
  if (!Array.isArray(members)) throw new RuleError("invalid_members");
  const rows: Row[] = members.map((m, i) => {
    if (typeof m !== "object" || m === null || Array.isArray(m))
      throw new RuleError("invalid_member");
    const r = m as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") throw new RuleError("invalid_member");
    if (typeof r.has_events !== "boolean") throw new RuleError("invalid_member");
    const progress = assertInt(r.progress_bps, "invalid_progress");
    if (progress < 0) throw new RuleError("invalid_progress");
    const reached = r.reached_at === null || r.reached_at === undefined ? null : r.reached_at;
    if (reached !== null && (typeof reached !== "string" || !TIME.test(reached)))
      throw new RuleError("invalid_time");
    return {
      id: r.id,
      progress,
      reached: reached as string | null,
      hasEvents: r.has_events,
      order: i,
    };
  });
  const shown = rows
    .filter((r) => r.hasEvents)
    .sort((a, b) => {
      if (a.progress !== b.progress) return b.progress - a.progress;
      if ((a.reached === null) !== (b.reached === null)) return a.reached === null ? 1 : -1;
      if (a.reached !== null && b.reached !== null && a.reached !== b.reached)
        return compareText(a.reached, b.reached);
      return a.order - b.order;
    });
  return {
    ranked: shown.map((r, n) => ({
      id: r.id,
      rank: n + 1,
      progress_bps: r.progress,
      reached_at: r.reached,
    })),
    hidden: rows.filter((r) => !r.hasEvents).map((r) => r.id),
  };
}
