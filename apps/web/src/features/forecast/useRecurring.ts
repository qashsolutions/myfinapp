import { daysInMonthOf } from "@stackd/rules/dates";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  bankText,
  type Entry,
  ignoreClosed,
  newId,
  type RecurringInterval,
  type RecurringKind,
  type RecurringSeries,
  type StackdDb,
} from "../../data/db.ts";
import {
  cleanDescription,
  type DetectedSeries,
  detectRecurring,
  merchantKey,
  merchantKeys,
  nextPaydays,
  type SeriesInput,
} from "../../engine/bridge.ts";
import { byLabel, compareText } from "../../lib/order.ts";
import { bankRows } from "../entries/splits.ts";

export const INTERVAL_LABELS: Record<RecurringInterval, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  yearly: "Yearly",
};

/** A suggestion's how-often, twice a month included (it is confirmed as one series per day). */
export function suggestionInterval(interval: DetectedSeries["interval"]): string {
  return interval === "semimonthly" ? "Twice a month" : INTERVAL_LABELS[interval];
}

export interface Suggestion extends DetectedSeries {
  /** The merchant text as the user saw it on the latest entry. */
  label: string;
}

export function toRecurringEntry(e: Entry) {
  return {
    id: e.id,
    date: e.date,
    amount_cents: e.amount_cents,
    direction: e.direction,
    is_transfer: e.is_transfer,
    payee: bankText(e), // the bank's text, never the person's rename (invariant 47)
  };
}

const MONTH_BASED = new Set<RecurringInterval>(["monthly", "quarterly", "yearly"]);

/**
 * A confirmed series as forecast.upcoming takes it, with the day of the month it is due (invariant
 * 49): the day it was confirmed with, else its next date's day for a series made before.
 */
export function seriesInput(s: RecurringSeries): SeriesInput {
  const input: SeriesInput = {
    id: s.id,
    payee: s.payee,
    kind: s.kind,
    expected_cents: s.expected_cents,
    interval: s.interval,
    next_date: s.next_date,
  };
  if (MONTH_BASED.has(s.interval)) input.day = s.day ?? Number(s.next_date.slice(8, 10));
  return input;
}

/**
 * "Looks recurring, found in your history": the recurring rule over every entry, minus the
 * payees the user has already confirmed or dismissed. Live with the database.
 */
export function useRecurringSuggestions(asOf: string): Suggestion[] | undefined {
  const { db } = useDb();
  const entries = useLiveQuery(() => db.entries.toArray(), [db]);
  const known = useLiveQuery(() => db.recurring_series.toArray(), [db]);
  const [suggestions, setSuggestions] = useState<Suggestion[] | undefined>(undefined);
  useEffect(() => {
    if (!entries || !known) return;
    let alive = true;
    void (async () => {
      const detected = await detectRecurring(bankRows(entries).map(toRecurringEntry), asOf);
      // Stored payees may predate the merchant key: compare keys (one merchant, one key).
      const keys = await merchantKeys(known.map((s) => s.payee));
      const seen = new Set(known.map((s) => `${keys.get(s.payee)}\u0000${s.kind}`));
      const byId = new Map(entries.map((e) => [e.id, e]));
      const fresh = detected
        .filter((s) => !seen.has(`${s.payee}\u0000${s.kind}`))
        .map((s) => {
          const latest = byId.get(s.entry_ids[s.entry_ids.length - 1] ?? "");
          return { ...s, label: latest?.merchant || s.payee };
        });
      if (alive) setSuggestions(fresh);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [entries, known, asOf]);
  return suggestions;
}

export function useRecurringSeries(
  status?: RecurringSeries["status"],
): RecurringSeries[] | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const rows = status
      ? await db.recurring_series.where("status").equals(status).toArray()
      : await db.recurring_series.toArray();
    return rows.sort((a, b) => compareText(a.next_date, b.next_date) || byLabel(a.label, b.label));
  }, [db, status]);
}

async function markRecurring(db: StackdDb, ids: string[], value: boolean): Promise<void> {
  const stamp = new Date().toISOString();
  await db.entries.bulkUpdate(
    ids.map((key) => ({ key, changes: { is_recurring: value, updated_at: stamp } })),
  );
}

/**
 * The series rows a suggestion becomes: one row keeping its usual day; twice a month becomes one
 * monthly row per day, each from its own next date after the last one seen (invariant 49).
 */
async function rowsFor(
  s: Suggestion,
  status: RecurringSeries["status"],
  stamp: string,
): Promise<RecurringSeries[]> {
  const base = {
    payee: s.payee,
    label: s.label,
    kind: s.kind,
    expected_cents: s.expected_cents,
    status,
    source: "detected" as const,
    account_id: null,
    created_at: stamp,
    updated_at: stamp,
  };
  if (s.interval !== "semimonthly")
    return [{ ...base, id: newId(), interval: s.interval, next_date: s.next_date, day: s.day }];
  const rows: RecurringSeries[] = [];
  for (const day of s.days ?? []) {
    const [next] = await nextPaydays(s.last_date, { kind: "monthly_days", days: [day] }, 1);
    rows.push({ ...base, id: newId(), interval: "monthly", next_date: next ?? s.next_date, day });
  }
  return rows;
}

export async function confirmSuggestion(db: StackdDb, s: Suggestion): Promise<RecurringSeries> {
  const rows = await rowsFor(s, "confirmed", new Date().toISOString());
  await db.recurring_series.bulkAdd(rows);
  await markRecurring(db, s.entry_ids, true);
  return rows[0] as RecurringSeries;
}

export async function dismissSuggestion(db: StackdDb, s: Suggestion): Promise<void> {
  // One row is enough to remember the payee, twice a month included.
  const [row] = await rowsFor(s, "dismissed", new Date().toISOString());
  if (row) await db.recurring_series.add(row);
}

export interface SeriesDraft {
  label: string;
  kind: RecurringKind;
  expected_cents: number;
  interval: RecurringInterval;
  next_date: string;
}

export async function addSeries(db: StackdDb, draft: SeriesDraft): Promise<RecurringSeries> {
  const stamp = new Date().toISOString();
  const row: RecurringSeries = {
    id: newId(),
    payee: await cleanDescription(draft.label),
    label: draft.label.trim(),
    kind: draft.kind,
    expected_cents: draft.expected_cents,
    interval: draft.interval,
    next_date: draft.next_date,
    day: dayOf(draft),
    status: "confirmed",
    source: "manual",
    account_id: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await db.recurring_series.add(row);
  return row;
}

/** The day of the month a hand-made series is due: its next date's (monthly and longer only). */
function dayOf(draft: Pick<SeriesDraft, "interval" | "next_date">): number | null {
  return MONTH_BASED.has(draft.interval) ? Number(draft.next_date.slice(8, 10)) : null;
}

export async function updateSeries(db: StackdDb, id: string, draft: SeriesDraft): Promise<void> {
  const row = await db.recurring_series.get(id);
  // A found bill keeps the bank's payee, so a new label never disconnects it from its charges
  // (invariant 47); its usual day stays unless the date or how often changed (invariant 49).
  const kept = row && row.next_date === draft.next_date && row.interval === draft.interval;
  await db.recurring_series.update(id, {
    payee: row?.source === "detected" ? row.payee : await cleanDescription(draft.label),
    label: draft.label.trim(),
    kind: draft.kind,
    expected_cents: draft.expected_cents,
    interval: draft.interval,
    next_date: draft.next_date,
    day: kept ? (row.day ?? dayOf(draft)) : dayOf(draft),
    updated_at: new Date().toISOString(),
  });
}

/**
 * Bills confirmed before series kept their day (invariant 49, October 29, 2026) have none, and
 * one may already have drifted to the 28th. Each such month-based series reads its day once from
 * its own charges: the recurring rule over the bank rows of the same merchant and direction gives
 * the run's most common day (the last day = 31). It is stored, and a next date that drifted off
 * it moves back onto it in its own month (clamped). A series whose charges no longer make a run
 * of the same interval keeps its next date's day. Asked once per series; returns the rows as stored.
 */
export async function backfillSeriesDays(
  db: StackdDb,
  series: RecurringSeries[],
  entries: Entry[],
  asOf: string,
): Promise<RecurringSeries[]> {
  const missing = series.filter((s) => MONTH_BASED.has(s.interval) && s.day == null);
  if (missing.length === 0) return series;
  const rows = bankRows(entries);
  const keys = await merchantKeys([...rows.map(bankText), ...missing.map((s) => s.payee)]);
  const out = new Map<string, RecurringSeries>();
  for (const s of missing) {
    const direction = s.kind === "income" ? "in" : "out";
    const own = rows.filter(
      (e) => e.direction === direction && keys.get(bankText(e)) === keys.get(s.payee),
    );
    const run = (await detectRecurring(own.map(toRecurringEntry), asOf)).find(
      (d) => d.interval === s.interval && d.day !== null,
    );
    // No run of the same interval: its next date's day, so it is asked only once.
    const day = run?.day ?? Number(s.next_date.slice(8, 10));
    const y = Number(s.next_date.slice(0, 4));
    const m = Number(s.next_date.slice(5, 7));
    const due = Math.min(day, daysInMonthOf(y, m));
    const next = `${s.next_date.slice(0, 8)}${String(due).padStart(2, "0")}`;
    const changes = { day, next_date: next, updated_at: new Date().toISOString() };
    await db.recurring_series.update(s.id, changes);
    out.set(s.id, { ...s, ...changes });
  }
  return series.map((s) => out.get(s.id) ?? s);
}

/** Removing a bill forgets it; its entries become ordinary spending again. */
export async function removeSeries(db: StackdDb, id: string): Promise<void> {
  const row = await db.recurring_series.get(id);
  await db.recurring_series.delete(id);
  await recordDeletion(db, "recurring_series", [id]);
  if (!row) return;
  const direction = row.kind === "income" ? "in" : "out";
  const flagged = await db.entries
    .filter((e) => e.is_recurring && e.direction === direction)
    .toArray();
  // One merchant, one key, on the bank's text (invariant 47).
  const payee = await merchantKey(row.payee);
  const keys = await merchantKeys(flagged.map(bankText));
  const ids = flagged.filter((e) => keys.get(bankText(e)) === payee).map((e) => e.id);
  if (ids.length) await markRecurring(db, ids, false);
}
