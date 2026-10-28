/** Port of stackd_rules/networth.py: assets, debts, net worth, per-group totals, debt share, change. */

import { addDays, type Day, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, ratioBps } from "./money.ts";
import { compareText } from "./text.ts";

export const GROUPS = {
  asset: ["cash", "savings", "investments", "retirement", "property", "vehicle", "other_asset"],
  debt: ["card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other_debt"],
} as const;

export type NetWorthKind = keyof typeof GROUPS;

export interface NetWorthGroup {
  kind: NetWorthKind;
  group: string;
  total_cents: number;
  count: number;
}

export interface NetWorthSummary {
  assets_cents: number;
  debts_cents: number;
  net_cents: number;
  debt_share_bps: number | null;
  change_cents: number | null;
  groups: NetWorthGroup[];
}

export function summary(items: unknown, previousNetCents: unknown): NetWorthSummary {
  if (!Array.isArray(items)) throw new RuleError("invalid_item");
  const previous = previousNetCents === null ? null : assertInt(previousNetCents);
  const seen = new Set<string>();
  const totals = new Map<
    string,
    { kind: NetWorthKind; group: string; total: number; count: number }
  >();
  const sums = { asset: 0, debt: 0 };
  for (const raw of items) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new RuleError("invalid_item");
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string") throw new RuleError("invalid_item");
    const kind = row.kind;
    if (kind !== "asset" && kind !== "debt") throw new RuleError("invalid_kind");
    const group = row.group;
    if (typeof group !== "string" || !(GROUPS[kind] as readonly string[]).includes(group))
      throw new RuleError("invalid_group");
    const value = assertInt(row.value_cents, "invalid_amount");
    if (value < 0) throw new RuleError("invalid_amount");
    if (seen.has(row.id)) throw new RuleError("duplicate_item");
    seen.add(row.id);
    sums[kind] += value;
    const key = `${kind}:${group}`;
    const entry = totals.get(key) ?? { kind, group, total: 0, count: 0 };
    entry.total += value;
    entry.count += 1;
    totals.set(key, entry);
  }
  const assets = sums.asset;
  const debts = sums.debt;
  const net = assets - debts;
  const order = { asset: 0, debt: 1 };
  const groups = [...totals.values()].sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    if (a.total !== b.total) return b.total - a.total;
    return compareText(a.group, b.group);
  });
  return {
    assets_cents: assets,
    debts_cents: debts,
    net_cents: net,
    debt_share_bps: ratioBps(debts, assets),
    change_cents: previous === null ? null : net - previous,
    groups: groups.map((g) => ({
      kind: g.kind,
      group: g.group,
      total_cents: g.total,
      count: g.count,
    })),
  };
}

export interface NetWorthPoint {
  date: string;
  assets_cents: number | null;
  debts_cents: number | null;
  net_cents: number | null;
  partial: boolean;
}

export interface NetWorthHistory {
  points: NetWorthPoint[];
  change_cents: number | null;
}

interface HistoryAccount {
  anchors: Array<[string, number]>;
  entries: Array<[string, number]>;
  knownFrom: string | null;
}

function record(raw: unknown, code: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RuleError(code);
  return raw as Record<string, unknown>;
}

function historyAccount(raw: unknown): HistoryAccount & { id: string } {
  const r = record(raw, "invalid_account");
  if (typeof r.id !== "string" || r.id === "") throw new RuleError("invalid_account");
  if (!Array.isArray(r.anchors) || !Array.isArray(r.entries))
    throw new RuleError("invalid_account");
  const anchors: Array<[string, number]> = r.anchors.map((a) => {
    const row = record(a, "invalid_anchor");
    return [iso(parseDate(row.as_of)), assertInt(row.balance_cents)];
  });
  // stable: same-day points keep their input order
  anchors.sort((a, b) => compareText(a[0], b[0]));
  const entries: Array<[string, number]> = r.entries.map((e) => {
    const row = record(e, "invalid_entry");
    const day = iso(parseDate(row.date));
    const cents = assertInt(row.amount_cents, "invalid_amount");
    if (cents < 0) throw new RuleError("invalid_amount");
    if (row.direction !== "in" && row.direction !== "out") throw new RuleError("invalid_direction");
    return [day, row.direction === "in" ? cents : -cents];
  });
  let knownFrom: string | null = null;
  const firstAnchor = anchors[0];
  if (firstAnchor) {
    knownFrom = firstAnchor[0];
    if (entries.length) {
      const earliest = entries.map(([d]) => d).sort()[0] as string;
      const before = iso(addDays(parseDate(earliest) as Day, -1));
      if (before < knownFrom) knownFrom = before;
    }
  }
  return { id: r.id, anchors, entries, knownFrom };
}

function balanceOn(account: HistoryAccount, day: string): number {
  const before = account.anchors.filter(([d]) => d <= day);
  const last = before[before.length - 1];
  if (last) {
    const [asOf, balance] = last;
    return account.entries.reduce((sum, [d, c]) => (asOf < d && d <= day ? sum + c : sum), balance);
  }
  const [asOf, balance] = account.anchors[0] as [string, number];
  return account.entries.reduce((sum, [d, c]) => (day < d && d <= asOf ? sum - c : sum), balance);
}

/** Assets, debts and net on each date, rebuilt from balance points and entries. */
export function history(dates: unknown, accounts: unknown, items: unknown): NetWorthHistory {
  if (!Array.isArray(dates)) throw new RuleError("invalid_dates");
  const days = dates.map((d) => iso(parseDate(d)));
  for (let i = 1; i < days.length; i++)
    if ((days[i] as string) <= (days[i - 1] as string)) throw new RuleError("invalid_dates");
  if (!Array.isArray(accounts) || !Array.isArray(items)) throw new RuleError("invalid_account");
  const parsed = accounts.map(historyAccount);
  if (new Set(parsed.map((a) => a.id)).size !== parsed.length)
    throw new RuleError("duplicate_account");
  const seen = new Set<string>();
  const fixed = items.map((raw) => {
    if (typeof raw !== "object" || raw === null || typeof (raw as { id?: unknown }).id !== "string")
      throw new RuleError("invalid_item");
    const r = raw as Record<string, unknown>;
    if (r.kind !== "asset" && r.kind !== "debt") throw new RuleError("invalid_kind");
    const value = assertInt(r.value_cents, "invalid_amount");
    if (value < 0) throw new RuleError("invalid_amount");
    if (seen.has(r.id as string)) throw new RuleError("duplicate_item");
    seen.add(r.id as string);
    return { kind: r.kind, value, since: iso(parseDate(r.since)) };
  });
  const points: NetWorthPoint[] = days.map((day) => {
    let assets = 0;
    let debts = 0;
    let known = 0;
    let partial = false;
    for (const a of parsed) {
      if (a.knownFrom === null) continue;
      if (day < a.knownFrom) {
        partial = true;
        continue;
      }
      known += 1;
      const balance = balanceOn(a, day);
      if (balance >= 0) assets += balance;
      else debts -= balance;
    }
    for (const item of fixed) {
      if (item.since > day) continue;
      known += 1;
      if (item.kind === "asset") assets += item.value;
      else debts += item.value;
    }
    return {
      date: day,
      assets_cents: known ? assets : null,
      debts_cents: known ? debts : null,
      net_cents: known ? assets - debts : null,
      partial,
    };
  });
  const nets = points.map((p) => p.net_cents).filter((n): n is number => n !== null);
  return {
    points,
    change_cents: nets.length >= 2 ? (nets[nets.length - 1] as number) - (nets[0] as number) : null,
  };
}
