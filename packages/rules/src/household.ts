/** Port of stackd_rules/household.py: the shared-jar split and the combined In / Out totals. */

import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";

export interface Contribution {
  member_id: string;
  cents: number;
}

export interface Split {
  contributions: Contribution[];
  total_cents: number;
}

export interface CombinedTotals {
  in_cents: number;
  out_cents: number;
  net_cents: number;
  members: number;
}

function memberIds(members: unknown): string[] {
  if (!Array.isArray(members) || members.length === 0) throw new RuleError("invalid_members");
  const ids: string[] = [];
  for (const m of members) {
    if (typeof m !== "string" || m === "" || ids.includes(m))
      throw new RuleError("invalid_members");
    ids.push(m);
  }
  return ids;
}

export function splitContributions(events: unknown, members: unknown): Split {
  const ids = memberIds(members);
  if (!Array.isArray(events)) throw new RuleError("invalid_events");
  const totals = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of events) {
    if (typeof e !== "object" || e === null || Array.isArray(e))
      throw new RuleError("invalid_event");
    const r = e as Record<string, unknown>;
    if (typeof r.member_id !== "string" || typeof r.type !== "string")
      throw new RuleError("invalid_event");
    if (!totals.has(r.member_id)) throw new RuleError("unknown_member");
    if (r.type !== "deposit") continue;
    const cents = assertInt(r.amount_cents, "invalid_amount");
    if (cents < 0) throw new RuleError("invalid_amount");
    totals.set(r.member_id, (totals.get(r.member_id) ?? 0) + cents);
  }
  let total = 0;
  for (const v of totals.values()) total += v;
  return {
    contributions: ids.map((id) => ({ member_id: id, cents: totals.get(id) ?? 0 })),
    total_cents: total,
  };
}

export function combineTotals(summaries: unknown): CombinedTotals {
  if (!Array.isArray(summaries)) throw new RuleError("invalid_summaries");
  const seen = new Set<string>();
  let inCents = 0;
  let outCents = 0;
  for (const s of summaries) {
    if (typeof s !== "object" || s === null || Array.isArray(s))
      throw new RuleError("invalid_summary");
    const r = s as Record<string, unknown>;
    if (typeof r.member_id !== "string" || r.member_id === "")
      throw new RuleError("invalid_summary");
    if (seen.has(r.member_id)) throw new RuleError("duplicate_member");
    seen.add(r.member_id);
    const i = assertInt(r.in_cents, "invalid_amount");
    const o = assertInt(r.out_cents, "invalid_amount");
    if (i < 0 || o < 0) throw new RuleError("invalid_amount");
    inCents += i;
    outCents += o;
  }
  return {
    in_cents: inCents,
    out_cents: outCents,
    net_cents: inCents - outCents,
    members: seen.size,
  };
}
