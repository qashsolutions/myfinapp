import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type Entry,
  ignoreClosed,
  newId,
  type RecurringInterval,
  type RecurringKind,
  type RecurringSeries,
  type StackdDb,
} from "../../data/db.ts";
import { cleanDescription, type DetectedSeries, detectRecurring } from "../../engine/bridge.ts";
import { byLabel, compareText } from "../../lib/order.ts";
import { bankRows } from "../entries/splits.ts";

export const INTERVAL_LABELS: Record<RecurringInterval, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  yearly: "Yearly",
};

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
    payee: e.merchant || e.clean_description,
  };
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
      const seen = new Set(known.map((s) => `${s.payee}\u0000${s.kind}`));
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

export async function confirmSuggestion(db: StackdDb, s: Suggestion): Promise<RecurringSeries> {
  const stamp = new Date().toISOString();
  const row: RecurringSeries = {
    id: newId(),
    payee: s.payee,
    label: s.label,
    kind: s.kind,
    expected_cents: s.expected_cents,
    interval: s.interval,
    next_date: s.next_date,
    status: "confirmed",
    source: "detected",
    account_id: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await db.recurring_series.add(row);
  await markRecurring(db, s.entry_ids, true);
  return row;
}

export async function dismissSuggestion(db: StackdDb, s: Suggestion): Promise<void> {
  const stamp = new Date().toISOString();
  await db.recurring_series.add({
    id: newId(),
    payee: s.payee,
    label: s.label,
    kind: s.kind,
    expected_cents: s.expected_cents,
    interval: s.interval,
    next_date: s.next_date,
    status: "dismissed",
    source: "detected",
    account_id: null,
    created_at: stamp,
    updated_at: stamp,
  });
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
    status: "confirmed",
    source: "manual",
    account_id: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await db.recurring_series.add(row);
  return row;
}

export async function updateSeries(db: StackdDb, id: string, draft: SeriesDraft): Promise<void> {
  await db.recurring_series.update(id, {
    payee: await cleanDescription(draft.label),
    label: draft.label.trim(),
    kind: draft.kind,
    expected_cents: draft.expected_cents,
    interval: draft.interval,
    next_date: draft.next_date,
    updated_at: new Date().toISOString(),
  });
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
  const ids: string[] = [];
  for (const e of flagged) {
    if ((await cleanDescription(e.merchant || e.clean_description)) === row.payee) ids.push(e.id);
  }
  if (ids.length) await markRecurring(db, ids, false);
}
