import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type Account,
  type NetWorthItem,
  type NetWorthSnapshot,
  newId,
  type StackdDb,
} from "../../data/db.ts";
import {
  engine,
  type NetWorthInputItem,
  type NetWorthPoint,
  type NetWorthSummary,
  netWorthHistory,
  netWorthSummary,
  ratioBps,
  startBalance,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { netWorthDates, type Range, type RangeBounds, rangeBounds } from "../ranges/ranges.ts";

export const ASSET_GROUPS = [
  ["cash", "Cash & checking"],
  ["savings", "Savings"],
  ["investments", "Investments"],
  ["retirement", "Retirement"],
  ["property", "Home & property"],
  ["vehicle", "Vehicles"],
  ["other_asset", "Other"],
] as const;
export const DEBT_GROUPS = [
  ["card", "Credit cards"],
  ["mortgage", "Mortgage"],
  ["auto_loan", "Car loans"],
  ["student_loan", "Student loans"],
  ["personal_loan", "Personal loans"],
  ["other_debt", "Other debts"],
] as const;
export const GROUP_LABEL: Record<string, string> = Object.fromEntries([
  ...ASSET_GROUPS,
  ...DEBT_GROUPS,
]);

/** A hand-added value older than this asks to be updated. */
export const STALE_DAYS = 30;

/** One line on the net worth screen: a Qash account, a debt from Debt payoff, or a hand-added item. */
export interface WorthRow {
  key: string;
  source: NetWorthItem["source"];
  refId: string | null;
  itemId: string | null;
  kind: "asset" | "debt";
  group: string;
  label: string;
  /** null: an account with no balance yet (set one in Accounts). */
  valueCents: number | null;
  included: boolean;
  updatedAt: string | null;
}

export interface NetWorthView {
  loading: boolean;
  rows: WorthRow[];
  summary: NetWorthSummary | null;
  /** Oldest first, at most 12 months. */
  history: NetWorthSnapshot[];
  stale: number;
}

/** A debt from Debt payoff has a name only; its kind of loan is read from words in it (display only). */
export function debtGroupFor(label: string): string {
  const l = label.toLowerCase();
  if (/mortgage|home loan|heloc/.test(l)) return "mortgage";
  if (/\bcar\b|auto|vehicle|truck/.test(l)) return "auto_loan";
  if (/student|college|school/.test(l)) return "student_loan";
  if (/card|visa|mastercard|amex|discover/.test(l)) return "card";
  if (/loan/.test(l)) return "personal_loan";
  return "other_debt";
}

function accountGroup(account: Account, cents: number): { kind: "asset" | "debt"; group: string } {
  // A balance below zero is owed: a credit card (stored negative), or an overdrawn account.
  if (cents < 0)
    return { kind: "debt", group: account.type === "credit_card" ? "card" : "other_debt" };
  return { kind: "asset", group: account.type === "savings" ? "savings" : "cash" };
}

/**
 * Net worth (owner decision, October 19, 2026): the person's accounts at their latest balance,
 * their debts from Debt payoff and anything they add by hand, each account and debt with an
 * Include switch, through `networth.summary`. The month's total is kept as a snapshot so the
 * card can say what changed since last month and the screen can draw the year.
 */
export function useNetWorth(asOf: string): NetWorthView {
  const { db } = useDb();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [db]);
  const anchors = useLiveQuery(() => db.balance_anchors.toArray(), [db]);
  const entries = useLiveQuery(() => db.entries.toArray(), [db]);
  const debts = useLiveQuery(() => db.debts.toArray(), [db]);
  const items = useLiveQuery(() => db.net_worth_items.toArray(), [db]);
  const snapshots = useLiveQuery(() => db.net_worth_snapshots.toArray(), [db]);
  const [balances, setBalances] = useState<Map<string, number | null> | null>(null);
  const [summary, setSummary] = useState<NetWorthSummary | null>(null);

  // Each account's balance today: its latest anchor plus the entries since (forecast.start_balance).
  useEffect(() => {
    if (!accounts || !anchors || !entries) return;
    let alive = true;
    void (async () => {
      const out = new Map<string, number | null>();
      for (const account of accounts) {
        const anchor =
          [...anchors]
            .filter((a) => a.account_id === account.id)
            .sort(
              (a, b) => compareText(b.as_of, a.as_of) || compareText(b.created_at, a.created_at),
            )[0] ?? null;
        if (!anchor) {
          out.set(account.id, null);
          continue;
        }
        // Every entry and every split part: together they are the bank's rows, counted once
        const since = entries.filter((e) => e.account_id === account.id);
        const start = await startBalance(
          { as_of: anchor.as_of, balance_cents: anchor.balance_cents },
          since.map((e) => ({
            date: e.date,
            amount_cents: e.amount_cents,
            direction: e.direction,
          })),
        );
        out.set(account.id, start.balance_cents);
      }
      if (alive) setBalances(out);
    })();
    return () => {
      alive = false;
    };
  }, [accounts, anchors, entries]);

  const rows = useMemo<WorthRow[] | null>(() => {
    if (!accounts || !debts || !items || !balances) return null;
    const choice = (source: "account" | "debt", id: string) =>
      items.find((i) => i.source === source && i.ref_id === id);
    const out: WorthRow[] = [];
    for (const a of accounts) {
      const cents = balances.get(a.id) ?? null;
      const picked = choice("account", a.id);
      const natural = accountGroup(a, cents ?? 0);
      out.push({
        key: `account:${a.id}`,
        source: "account",
        refId: a.id,
        itemId: picked?.id ?? null,
        kind: natural.kind,
        group: picked && picked.kind === natural.kind ? picked.group : natural.group,
        label: a.last4 ? `${a.label} ••${a.last4}` : a.label,
        valueCents: cents === null ? null : Math.abs(cents),
        included: picked?.included ?? true,
        updatedAt: null,
      });
    }
    for (const d of debts) {
      const picked = choice("debt", d.id);
      out.push({
        key: `debt:${d.id}`,
        source: "debt",
        refId: d.id,
        itemId: picked?.id ?? null,
        kind: "debt",
        group: picked?.group ?? debtGroupFor(d.label),
        label: d.label,
        valueCents: d.balance_cents,
        included: picked?.included ?? true,
        updatedAt: d.updated_at,
      });
    }
    for (const i of items.filter((x) => x.source === "manual"))
      out.push({
        key: `manual:${i.id}`,
        source: "manual",
        refId: null,
        itemId: i.id,
        kind: i.kind,
        group: i.group,
        label: i.label,
        valueCents: i.value_cents ?? 0,
        included: true,
        updatedAt: i.updated_at,
      });
    return out;
  }, [accounts, debts, items, balances]);

  const month = asOf.slice(0, 7);
  const sorted = useMemo(
    () => [...(snapshots ?? [])].sort((a, b) => compareText(a.month, b.month)),
    [snapshots],
  );
  const previous = [...sorted].reverse().find((s) => s.month < month) ?? null;

  useEffect(() => {
    if (!rows || !snapshots) return;
    let alive = true;
    void (async () => {
      const input: NetWorthInputItem[] = rows
        .filter((r) => r.included && r.valueCents !== null)
        .map((r) => ({ id: r.key, kind: r.kind, group: r.group, value_cents: r.valueCents ?? 0 }));
      const result = await netWorthSummary(input, previous?.net_cents ?? null);
      if (!alive) return;
      setSummary(result);
      const version = engine.rulesVersion ?? "unknown";
      await db.computed_results.put({
        id: `net_worth:${asOf}`,
        kind: "net_worth",
        as_of: asOf,
        rules_version: version,
        payload: result,
        computed_at: new Date().toISOString(),
      });
      // This month's snapshot follows the latest total; written only when something counts.
      const current = snapshots.find((s) => s.month === month);
      const empty = input.length === 0;
      if (
        !empty &&
        (!current ||
          current.net_cents !== result.net_cents ||
          current.assets_cents !== result.assets_cents ||
          current.debts_cents !== result.debts_cents)
      )
        await db.net_worth_snapshots.put({
          month,
          assets_cents: result.assets_cents,
          debts_cents: result.debts_cents,
          net_cents: result.net_cents,
          rules_version: version,
          updated_at: new Date().toISOString(),
        });
    })();
    return () => {
      alive = false;
    };
  }, [rows, snapshots, previous, month, asOf, db]);

  const staleBefore = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  return {
    loading: rows === null || summary === null,
    rows: rows ?? [],
    summary,
    history: sorted.slice(-12),
    stale: (rows ?? []).filter(
      (r) => r.source === "manual" && r.updatedAt !== null && r.updatedAt < staleBefore,
    ).length,
  };
}

/** Include or leave out a Qash account or debt; its group can be changed too (a debt's kind of loan). */
export async function chooseFor(
  db: StackdDb,
  row: WorthRow,
  change: { included?: boolean; group?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const existing = row.itemId ? await db.net_worth_items.get(row.itemId) : undefined;
  await db.net_worth_items.put({
    id: existing?.id ?? newId(),
    kind: row.kind,
    group: change.group ?? existing?.group ?? row.group,
    label: row.label,
    value_cents: null,
    source: row.source,
    ref_id: row.refId,
    included: change.included ?? existing?.included ?? row.included,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}

/** Add or update something owned or owed by hand. */
export async function saveManual(
  db: StackdDb,
  item: { id?: string; kind: "asset" | "debt"; group: string; label: string; value_cents: number },
): Promise<void> {
  const now = new Date().toISOString();
  const existing = item.id ? await db.net_worth_items.get(item.id) : undefined;
  await db.net_worth_items.put({
    id: existing?.id ?? newId(),
    kind: item.kind,
    group: item.group,
    label: item.label,
    value_cents: item.value_cents,
    source: "manual",
    ref_id: null,
    included: true,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}

export async function removeManual(db: StackdDb, id: string): Promise<void> {
  await db.transaction("rw", db.net_worth_items, db.tombstones, async () => {
    await db.net_worth_items.delete(id);
    await recordDeletion(db, "net_worth_items", [id]);
  });
}

export interface NetWorthRangeView {
  bounds: RangeBounds | null;
  points: NetWorthPoint[];
  change: number | null;
  /** change ÷ the first known net, when the first and last nets are both above zero. */
  changeBps: number | null;
  /** Some included account starts after the first date (its history begins with its first entry). */
  partial: boolean;
  /** Debts or hand-added things that count only from the day they were added, inside the range. */
  addedLater: boolean;
}

/**
 * Net worth over a time range (docs/spec.md "Time ranges"): the included accounts rebuilt from
 * their balance points and entries, debts and hand-added things from the day they were added.
 */
export function useNetWorthRange(
  rows: WorthRow[],
  range: Range,
  today: string,
  back = 0,
): NetWorthRangeView {
  const { db } = useDb();
  const anchors = useLiveQuery(() => db.balance_anchors.toArray(), [db]);
  const entries = useLiveQuery(() => db.entries.toArray(), [db]);
  const debts = useLiveQuery(() => db.debts.toArray(), [db]);
  const items = useLiveQuery(() => db.net_worth_items.toArray(), [db]);
  const [view, setView] = useState<NetWorthRangeView>({
    bounds: null,
    points: [],
    change: null,
    changeBps: null,
    partial: false,
    addedLater: false,
  });
  const first = useMemo(
    () => (entries ? ([...entries].map((e) => e.date).sort()[0] ?? null) : undefined),
    [entries],
  );
  useEffect(() => {
    if (!anchors || !entries || !debts || !items || first === undefined) return;
    let alive = true;
    void (async () => {
      const bounds = await rangeBounds(range, today, first, back);
      const dates = await netWorthDates(bounds);
      const included = rows.filter((r) => r.included);
      const accounts = included
        .filter((r) => r.source === "account" && r.refId)
        .map((r) => ({
          id: r.refId as string,
          anchors: anchors
            .filter((a) => a.account_id === r.refId)
            .map((a) => ({ as_of: a.as_of, balance_cents: a.balance_cents })),
          entries: entries
            .filter((e) => e.account_id === r.refId) // split parts included, as above
            .map((e) => ({ date: e.date, amount_cents: e.amount_cents, direction: e.direction })),
        }));
      const fixed = included
        .filter((r) => r.source !== "account" && r.valueCents !== null)
        .map((r) => {
          const made =
            r.source === "debt"
              ? debts.find((d) => d.id === r.refId)?.created_at
              : items.find((i) => i.id === r.itemId)?.created_at;
          return {
            id: r.key,
            kind: r.kind,
            value_cents: r.valueCents ?? 0,
            since: (made ?? today).slice(0, 10),
          };
        });
      const result = await netWorthHistory(dates, accounts, fixed);
      const known = result.points.filter((p) => p.net_cents !== null);
      const firstNet = known[0]?.net_cents ?? null;
      const lastNet = known[known.length - 1]?.net_cents ?? null;
      // A percent only reads true while both ends are above zero ("−101%" says nothing).
      const changeBps =
        result.change_cents !== null &&
        firstNet !== null &&
        lastNet !== null &&
        firstNet > 0 &&
        lastNet > 0
          ? await ratioBps(result.change_cents, firstNet)
          : null;
      if (!alive) return;
      setView({
        bounds,
        points: result.points,
        change: result.change_cents,
        changeBps,
        partial: result.points.some((p) => p.partial),
        addedLater: fixed.some((f) => f.since > (dates[0] ?? today)),
      });
    })();
    return () => {
      alive = false;
    };
  }, [rows, range, today, back, anchors, entries, debts, items, first]);
  return view;
}
