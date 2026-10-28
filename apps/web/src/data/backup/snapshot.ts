/**
 * The backup's contents and how two devices agree (docs/spec.md chunk 1.16, "Two devices stay
 * in sync with ciphertext-only server storage").
 *
 * A snapshot is every synced table as plain rows plus the tombstones of rows deleted here.
 * Merging a snapshot into this device is row by row: a row this device does not have is added
 * (unless it was deleted here after the other device last touched it); a row both have keeps
 * the newer `updated_at`, or the local one when the table has none; a remote tombstone removes
 * the local row when it is not newer than the deletion. Files (statement copies, receipt
 * photos) and derived tables (computed results, forecasts, the server queue) never travel.
 */

import { compareText } from "../../lib/order.ts";
import type { StackdDb, Tombstone } from "../db.ts";
import { sha256Hex } from "./crypto.ts";

export const SNAPSHOT_FORMAT = "stackd-backup";
export const SNAPSHOT_VERSION = 1;

/** Tables that sync, with the field that says which copy is newer (null = first write wins). */
export const SYNCED_TABLES: Array<{
  name: SyncedTable;
  key: string;
  updatedAt: "updated_at" | null;
}> = [
  { name: "accounts", key: "id", updatedAt: null },
  { name: "categories", key: "id", updatedAt: "updated_at" },
  { name: "entries", key: "id", updatedAt: "updated_at" },
  { name: "statement_imports", key: "id", updatedAt: null },
  { name: "csv_mappings", key: "account_id", updatedAt: "updated_at" },
  { name: "balance_anchors", key: "id", updatedAt: null },
  { name: "merchant_rules", key: "id", updatedAt: null },
  { name: "merchant_names", key: "id", updatedAt: "updated_at" },
  { name: "budgets", key: "id", updatedAt: "updated_at" },
  { name: "budget_lines", key: "id", updatedAt: null },
  { name: "settings", key: "key", updatedAt: "updated_at" },
  { name: "goals", key: "id", updatedAt: "updated_at" },
  { name: "goal_events", key: "id", updatedAt: null },
  { name: "goal_milestones", key: "id", updatedAt: "updated_at" },
  { name: "goal_templates", key: "id", updatedAt: null },
  { name: "recurring_series", key: "id", updatedAt: "updated_at" },
  { name: "debts", key: "id", updatedAt: "updated_at" },
  { name: "emergency_fund", key: "id", updatedAt: "updated_at" },
  { name: "net_worth_items", key: "id", updatedAt: "updated_at" },
  { name: "net_worth_snapshots", key: "month", updatedAt: "updated_at" },
];

export type SyncedTable =
  | "accounts"
  | "categories"
  | "entries"
  | "statement_imports"
  | "csv_mappings"
  | "balance_anchors"
  | "merchant_rules"
  | "merchant_names"
  | "budgets"
  | "budget_lines"
  | "settings"
  | "goals"
  | "goal_events"
  | "goal_milestones"
  | "goal_templates"
  | "recurring_series"
  | "debts"
  | "emergency_fund"
  | "net_worth_items"
  | "net_worth_snapshots";

/** Settings rows that describe this device or its sync state, never another device's. */
const LOCAL_SETTING_PREFIXES = ["backup.", "household.", "alerts.last_hash", "forecast.account_id"];

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  rules_version: string;
  device_id: string;
  created_at: string;
  tables: Record<SyncedTable, Record<string, unknown>[]>;
  tombstones: Tombstone[];
}

type Row = Record<string, unknown>;

function isLocalSetting(row: Row): boolean {
  const key = String(row.key ?? "");
  return LOCAL_SETTING_PREFIXES.some((p) => key.startsWith(p));
}

function sortedRows(rows: Row[], key: string): Row[] {
  return [...rows].sort((a, b) => compareText(String(a[key]), String(b[key])));
}

export async function buildSnapshot(
  db: StackdDb,
  meta: { rulesVersion: string; deviceId: string; now?: Date },
): Promise<Snapshot> {
  const tables = {} as Snapshot["tables"];
  // One read transaction: a delete and its tombstone (or any write) land wholly in or out.
  const tombstones = await db.transaction(
    "r",
    [...SYNCED_TABLES.map((t) => db.table(t.name)), db.tombstones],
    async () => {
      for (const t of SYNCED_TABLES) {
        const rows = (await db.table(t.name).toArray()) as Row[];
        tables[t.name] = sortedRows(
          t.name === "settings" ? rows.filter((r) => !isLocalSetting(r)) : rows,
          t.key,
        );
      }
      return (await db.tombstones.toArray()).sort((a, b) =>
        compareText(`${a.table}:${a.id}`, `${b.table}:${b.id}`),
      );
    },
  );
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    rules_version: meta.rulesVersion,
    device_id: meta.deviceId,
    created_at: (meta.now ?? new Date()).toISOString(),
    tables,
    tombstones,
  };
}

/** Same data → same hash, whatever device built it: rows sorted by key, keys sorted inside. */
export async function snapshotHash(snapshot: Snapshot): Promise<string> {
  const canonical = JSON.stringify(
    { tables: snapshot.tables, tombstones: snapshot.tombstones },
    (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Row).sort(([a], [b]) => compareText(a, b)))
        : value,
  );
  return sha256Hex(canonical);
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Snapshot>;
  return (
    v.format === SNAPSHOT_FORMAT &&
    v.version === SNAPSHOT_VERSION &&
    !!v.tables &&
    Array.isArray(v.tombstones)
  );
}

/** Remember a deletion so a sync from another device does not undo it. */
export async function recordDeletion(
  db: StackdDb,
  table: SyncedTable,
  ids: string[],
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  const deleted_at = now.toISOString();
  await db.tombstones.bulkPut(ids.map((id) => ({ table, id, deleted_at })));
}

export interface MergeReport {
  added: number;
  updated: number;
  removed: number;
  /** Rows a unique index already holds under another id (the same import row), left out. */
  skipped: number;
}

function stamp(row: Row, updatedAt: "updated_at" | null): string {
  return String((updatedAt ? row[updatedAt] : null) ?? row.created_at ?? "");
}

/** Apply another device's snapshot to this one (see the module note for the rules). */
export async function mergeSnapshot(db: StackdDb, snapshot: Snapshot): Promise<MergeReport> {
  const report: MergeReport = { added: 0, updated: 0, removed: 0, skipped: 0 };
  const tables = SYNCED_TABLES.map((t) => db.table(t.name));
  await db.transaction("rw", [...tables, db.tombstones], async () => {
    const local = new Map<string, Tombstone>(
      (await db.tombstones.toArray()).map((t) => [`${t.table}:${t.id}`, t]),
    );
    // Remote deletions first, so a row deleted elsewhere does not get re-added below.
    for (const t of snapshot.tombstones) {
      const spec = SYNCED_TABLES.find((s) => s.name === t.table);
      if (!spec) continue;
      const mine = local.get(`${t.table}:${t.id}`);
      if (!mine || mine.deleted_at < t.deleted_at) {
        await db.tombstones.put(t);
        local.set(`${t.table}:${t.id}`, t);
      }
      const existing = (await db.table(t.table).get(t.id)) as Row | undefined;
      if (existing && stamp(existing, spec.updatedAt) <= t.deleted_at) {
        await db.table(t.table).delete(t.id);
        report.removed += 1;
      }
    }
    for (const spec of SYNCED_TABLES) {
      const rows = snapshot.tables[spec.name] ?? [];
      const table = db.table(spec.name);
      for (const remote of rows) {
        if (spec.name === "settings" && isLocalSetting(remote)) continue;
        const id = String(remote[spec.key]);
        const tomb = local.get(`${spec.name}:${id}`);
        if (tomb && stamp(remote, spec.updatedAt) <= tomb.deleted_at) continue;
        const existing = (await table.get(id)) as Row | undefined;
        if (!existing) {
          try {
            await table.add(remote);
            report.added += 1;
          } catch (error) {
            // a unique index (an import fingerprint) already holds this row under another id;
            // anything else is a real failure and aborts the merge
            if ((error as { name?: string } | null)?.name !== "ConstraintError") throw error;
            report.skipped += 1;
          }
        } else if (
          spec.updatedAt &&
          stamp(remote, spec.updatedAt) > stamp(existing, spec.updatedAt)
        ) {
          await table.put(remote);
          report.updated += 1;
        }
      }
    }
  });
  return report;
}
