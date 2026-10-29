/**
 * The device-side database (docs/spec.md "Where each table lives": statements, receipts,
 * transactions, budgets, goals and every computed result live only here, in IndexedDB).
 *
 * One database per signed-in user, named by the user id, so two people sharing a browser
 * never see each other's data and account deletion (chunk 1.11) is a single deleteDatabase.
 * Money is integer cents; dates are ISO YYYY-MM-DD strings; ids are UUIDs made on the device.
 *
 * Tables arrive with their chunks; this version holds what manual entries need.
 */

import Dexie, { type EntityTable, type Table } from "dexie";
import { compareText } from "../lib/order.ts";
import { DEFAULT_ACCOUNT, DEFAULT_CATEGORIES } from "./defaults.ts";

export type AccountType = "checking" | "savings" | "credit_card" | "cash";

export interface Account {
  id: string;
  label: string;
  type: AccountType;
  last4: string | null;
  institution: string | null;
  currency: "USD";
  created_at: string;
  /** Phase 3: set while the account is read through a bank connection; cleared on Disconnect. */
  linked?: LinkedRef | null;
  /** A card's payment due day, 1-31 (31 = the month's last day), set by the person on a card
   * that isn't linked; Credit habits derives its due dates from it (October 28, 2026). */
  due_day?: number | null;
}

export interface LinkedRef {
  connection_id: string;
  /** The provider's id for this account, so later syncs land in the same place. */
  account_id: string;
}

export type Bucket = "need" | "want" | "save";

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income";
  bucket: Bucket | null; // income categories have none
  is_default: boolean;
  sort: number;
  /** A built-in category the person hid: out of the pickers, kept on its entries (October 20, 2026). */
  hidden?: boolean;
  /** Set on every change so a rename on one device wins on the other (backups compare it). */
  updated_at?: string;
}

export type Direction = "in" | "out";
export type EntrySource = "manual" | "receipt" | "import" | "linked";

export interface Entry {
  id: string;
  date: string; // YYYY-MM-DD, the user's local date
  amount_cents: number; // always positive; `direction` carries the sign
  direction: Direction;
  merchant: string;
  clean_description: string;
  raw_description: string | null; // imports keep the bank's text (chunk 1.3b)
  category_id: string | null;
  account_id: string;
  source: EntrySource;
  receipt_id: string | null; // chunk 1.9
  import_id: string | null; // chunk 1.3b
  fingerprint?: string; // imports and linked rows; unique per account (undefined is not indexed)
  /** Linked accounts (chunk 3.3): the provider's transaction id; an uploaded entry it matched keeps
   * its own id and gains this one, so the two never count twice. */
  provider_txn_id?: string;
  pending?: boolean; // linked only: not posted yet; replaced when the bank posts it
  is_transfer: boolean;
  transfer_pair_id: string | null;
  split_parent_id: string | null;
  is_recurring: boolean;
  /** The person's own note (owner decision, October 19, 2026), at most NOTE_MAX characters. */
  note?: string | null;
  /** Tags group entries across categories, like a trip; at most MAX_TAGS, each case-insensitively unique. */
  tags?: string[];
  /** "Don't count" (October 20, 2026): left out of every spending total, kept in balances and net worth. */
  not_counted?: boolean;
  /** The person named this entry themselves, so a bank sync never puts the bank's text back. */
  renamed?: boolean;
  created_at: string;
  updated_at: string;
}

export type ImportFormat = "csv" | "ofx" | "pdf";

export interface StatementImport {
  id: string;
  account_id: string;
  format: ImportFormat;
  template_key: string | null; // PDF templates, fast-follow 2
  file_name: string;
  period_start: string | null;
  period_end: string | null;
  ending_balance_cents: number | null;
  rows_found: number;
  rows_added: number;
  rows_skipped: number;
  file_key: string | null; // files.id while a copy is kept on the device
  status: "done";
  created_at: string;
}

export type DateFormat = "MDY" | "DMY" | "YMD";
export type SignConvention = "negative_out" | "negative_in";

/** Column indexes into the CSV header row; null when the file has no such column. */
export interface CsvMapping {
  date: number;
  description: number;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  sign: SignConvention;
  date_format: DateFormat;
}

export interface CsvMappingRow {
  account_id: string;
  mapping: CsvMapping;
  updated_at: string;
}

export interface BalanceAnchor {
  id: string;
  account_id: string;
  as_of: string;
  balance_cents: number;
  source: "statement" | "user" | "linked";
  created_at: string;
}

/** "Always put CORNER MKT in Groceries": a user correction that became a rule. */
/** "Rename all like this" (October 20, 2026): entries whose cleaned bank text is `match` show `name`. */
export interface MerchantName {
  id: string;
  match: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/**
 * The person's own subscription kind (October 29, 2026; docs/spec.md "Subscriptions"): picked like
 * a built-in kind. `id` starts with `own-` so it never meets a kind of the table.
 */
export interface OwnSubscriptionKind {
  id: string;
  label: string;
  created_at: string;
  updated_at: string;
}

/**
 * "When a charge says NETFLIX, it's Video streaming" (October 29, 2026): `match` is upper-case
 * like the table's words, `kind` a built-in kind or an own kind's id. Tried before the table.
 */
export interface OwnSubscriptionWord {
  id: string;
  match: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface MerchantRule {
  id: string;
  match: string;
  category_id: string;
  created_at: string;
}

/** Statement files and receipt photos the user chose to keep on the device. */
export interface StoredFile {
  id: string;
  kind: "statement" | "receipt";
  import_id: string | null;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  created_at: string;
}

/** A stored rule result with the rules_version that produced it (docs/spec.md "Proving determinism"). */
export interface ComputedResult {
  id: string; // `${kind}:${as_of}`
  kind: string;
  as_of: string;
  rules_version: string;
  payload: unknown;
  computed_at: string;
}

export type BudgetMethod = "50_30_20" | "zero_based";

/** One budget per month (docs/spec.md data model: budgets, budget_lines). */
export interface Budget {
  id: string;
  month: string; // YYYY-MM
  method: BudgetMethod;
  take_home_cents: number;
  /** The bucket method's own split in bps (October 20, 2026); absent means 50/30/20. */
  split_bps?: { need: number; want: number; save: number } | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetLine {
  id: string;
  budget_id: string;
  category_id: string;
  planned_cents: number;
}

export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

/** Settings → value, for small per-user preferences kept on the device. */
export interface Setting {
  key: string;
  value: unknown;
  updated_at: string;
}

export interface PaySettings {
  amount_cents: number;
  frequency: PayFrequency;
  next_payday: string | null;
  monthly_cents: number;
  /**
   * Twice a month: the two days; monthly: the one day (31 = the last day). Chosen by the person
   * (October 28, 2026); unset on pay saved before then, which keeps its old reading.
   */
  days?: number[] | null;
}

export type GoalKind = "save" | "payoff" | "spend_less" | "habit";
export type GoalStatus = "active" | "reached" | "archived";

/** docs/spec.md data model: goals (one model for jars, payoff, spend less, habit, challenges). */
export interface Goal {
  id: string;
  kind: GoalKind;
  title: string; // "Travel", "Card A", "Dining", "no eating out"
  target_cents: number | null; // save, payoff (starting balance), spend_less (amount to save)
  target_days: number | null; // habit
  label: string | null; // habit: what; spend_less: category name snapshot
  category_id: string | null; // spend_less
  start_date: string;
  end_date: string | null;
  baseline_cents: number | null; // spend_less
  group_id: string | null; // chunk 1.6
  household_id?: string | null; // chunk 1.16: a jar shared with the partner
  // fast-follow 3: custom-goal extras
  cadence?: GoalCadence | null; // how often money is set aside
  per_period_cents?: number | null; // fixed amount per period (the finish date follows)
  is_ongoing?: boolean; // no end and no target: "save $X every period", tracked as a streak
  paused_at?: string | null; // paused: no alerts, the streak holds
  pauses?: Array<{ start: string; end: string | null }>; // every pause, for the streak
  priority?: number | null; // the user's order; lower first
  why_text?: string | null; // the user's own reason, shown on the card
  milestones_bps?: number[]; // checkpoints as basis points of the target (2500 = 25%)
  // October 28, 2026: a save jar that grows over time; target_cents is then its future cost
  grow?: GoalGrow | null;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

/** A goal that grows (growth.goal_plan): today's cost priced on a date, rising yearly, with the
 * person's own yearly growth rate for what they save. */
export interface GoalGrow {
  today_cents: number;
  cost_rise_bps: number;
  return_bps: number;
  priced_on: string; // the day today_cents was today's cost
}

export type GoalCadence = "weekly" | "biweekly" | "monthly" | "payday";
export type GoalEventType = "deposit" | "withdrawal" | "balance_update" | "checkin";

export interface GoalEvent {
  id: string;
  goal_id: string;
  date: string;
  type: GoalEventType;
  amount_cents: number | null;
  member_id?: string | null; // chunk 1.16: who added it, on a shared jar (user id)
  created_at: string;
}

/** docs/spec.md data model: goal_milestones. Stamped the first time the device sees one reached. */
export interface GoalMilestone {
  id: string; // `${goal_id}:${bps}`
  goal_id: string;
  bps: number;
  label: string;
  target_cents: number;
  reached_at: string | null;
  /** Syncs newer-wins, so a checkpoint removed and added back outlives the old removal. Rows
   * written before October 28, 2026 have none and count as oldest. */
  updated_at?: string;
}

/** docs/spec.md data model: goal_templates (private; sharing to a group is fast-follow 4). */
export interface GoalTemplate {
  id: string;
  name: string;
  payload: {
    kind: GoalKind;
    title: string;
    target_cents: number | null;
    months: number | null; // deadline as months from creation, or null for none
    cadence: GoalCadence | null;
    per_period_cents: number | null;
    is_ongoing: boolean;
    why_text: string | null;
    milestones_bps: number[];
  };
  created_at: string;
}

/**
 * A row removed on this device, so a sync from another device does not bring it back
 * (chunk 1.16). Every delete path records one through `data/backup/snapshot.recordDeletion`.
 */
export interface Tombstone {
  table: string;
  id: string;
  deleted_at: string;
}

export type RecurringInterval = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export type RecurringKind = "bill" | "income";
export type RecurringStatus = "suggested" | "confirmed" | "dismissed";

/** docs/spec.md data model: recurring_series (bills and expected income; feeds Upcoming and the forecast). */
export interface RecurringSeries {
  id: string;
  payee: string; // cleaned like a fingerprint ("CITY UTILITIES")
  label: string; // what the user sees ("City Utilities")
  kind: RecurringKind;
  expected_cents: number;
  interval: RecurringInterval;
  next_date: string;
  status: RecurringStatus;
  source: "detected" | "manual";
  account_id: string | null;
  /** The person's call (October 27, 2026): true / false; unset = from the payee's category. */
  subscription?: boolean | null;
  /** The last "Keep it" on the subscription check (October 28, 2026), a date; unset = never. */
  checked_at?: string | null;
  /**
   * The person's own kind for a subscription (October 29, 2026): one of the fixed kinds in
   * keywords.yaml `subscription_kind_names`, or "other" (no kind); unset = from the payee's
   * name. Synced with the row (newer `updated_at` wins), no index, so no new Dexie version.
   */
  subscription_kind?: string | null;
  /**
   * The day of the month a monthly, quarterly or yearly series is due (1–31, 31 = the last day;
   * October 29, 2026, invariant 49), passed to forecast.upcoming so the 31st never drifts to the
   * 28th. No index, so no new Dexie version; unset on series made before, which read their next
   * date's day.
   */
  day?: number | null;
  created_at: string;
  updated_at: string;
}

/** docs/spec.md data model: forecasts (one per as_of; the latest is what Home shows). */
export interface ForecastRow {
  id: string; // as_of
  as_of: string;
  rules_version: string;
  lowest_cents: number;
  lowest_date: string;
  shortfall: boolean;
  short_by_cents: number;
  payload: unknown; // the day-by-day projection and its inputs
  computed_at: string;
}

/** "90d", "1y" and "forever" are suggested; "<n>d" is the person's own number of days (1 to 3650). */
export type ReceiptRetention = "90d" | "1y" | "forever" | `${number}d`;
export type ReceiptStatus = "pending" | "confirmed";

/**
 * docs/spec.md data model: receipts. The photo is a `files` row (kind "receipt") that stays on
 * the device; `file_id` becomes null when retention removes it and the entry's amount stays.
 * The text read off the photo (fast-follow 6, on the device) is kept with the engine that
 * read it, so a suggestion can be reproduced; both are absent until the user asks.
 */
export interface Receipt {
  id: string;
  entry_id: string | null;
  file_id: string | null;
  status: ReceiptStatus;
  purge_after: string | null; // YYYY-MM-DD, null = keep forever
  purged_at: string | null;
  ocr_text?: string | null;
  ocr_engine_version?: string | null;
  created_at: string;
  updated_at: string;
}

/** docs/spec.md data model: debts (cards and loans the user types in; nothing is moved). */
/** Net worth (owner decision, October 19, 2026). Hand-added items carry their value; rows with
 * source `account` or `debt` only record the person's choices for that account or debt (its
 * Include switch and group), its value is always the live balance. */
export interface NetWorthItem {
  id: string;
  kind: "asset" | "debt";
  group: string;
  label: string;
  value_cents: number | null;
  source: "manual" | "account" | "debt";
  ref_id: string | null;
  included: boolean;
  created_at: string;
  updated_at: string;
}

/** One per month (YYYY-MM): the latest total seen that month, for the trend and "since last month". */
export interface NetWorthSnapshot {
  month: string;
  assets_cents: number;
  debts_cents: number;
  net_cents: number;
  rules_version: string;
  updated_at: string;
}

export interface Debt {
  id: string;
  label: string;
  balance_cents: number;
  apr_bps: number; // 2799 = 27.99%
  min_payment_cents: number;
  created_at: string;
  updated_at: string;
}

/**
 * Chunk 3.5: a linked card's statement facts from the issuer, keyed by the device account.
 * Refreshed after each sync (pass-through: the server keeps none of it); never synced to
 * backups, since the next pull brings it back.
 */
export interface CardDetail {
  account_id: string;
  statement_balance_cents: number | null;
  statement_date: string | null;
  due_date: string | null;
  minimum_cents: number | null;
  last_payment_cents: number | null;
  last_payment_date: string | null;
  limit_cents: number | null;
  apr_bps: number | null;
  is_overdue: boolean;
  updated_at: string;
}

/**
 * Every distinct due date seen on a linked card's facts, with what that statement asked for
 * (October 28, 2026; Dexie v17), so Credit habits can look back after `card_details` moves on.
 * In the encrypted backup (newer `updated_at` wins) so the history follows to a new device,
 * and in the export.
 */
export interface CardDueDate {
  id: string; // `${account_id}:${due_date}`
  account_id: string;
  due_date: string;
  statement_balance_cents: number | null;
  minimum_cents: number | null;
  updated_at: string;
}

/** docs/spec.md data model: emergency_fund. Saved comes from the jar; this is the rest. */
export interface EmergencyFund {
  id: "me";
  essentials_cents: number | null; // null = not entered yet (Budget's needs stand in)
  target_months: number; // 1 to 12 (emergency.summary); 3 and 6 are the suggestions
  monthly_plan_cents: number | null;
  updated_at: string;
}

/** Server-bound writes that may have to wait for the network (docs/spec.md `serverQueue.ts`). */
export interface ServerQueueItem {
  id: string; // one row per target, so the latest value wins: "group_progress:<group id>"
  kind: "group_progress";
  payload: { group_id: string; progress_bps: number };
  created_at: string;
  attempts: number;
}

export class StackdDb extends Dexie {
  accounts!: EntityTable<Account, "id">;
  categories!: EntityTable<Category, "id">;
  entries!: EntityTable<Entry, "id">;
  statement_imports!: EntityTable<StatementImport, "id">;
  csv_mappings!: EntityTable<CsvMappingRow, "account_id">;
  balance_anchors!: EntityTable<BalanceAnchor, "id">;
  merchant_rules!: EntityTable<MerchantRule, "id">;
  merchant_names!: EntityTable<MerchantName, "id">;
  own_subscription_kinds!: EntityTable<OwnSubscriptionKind, "id">;
  own_subscription_words!: EntityTable<OwnSubscriptionWord, "id">;
  files!: EntityTable<StoredFile, "id">;
  computed_results!: EntityTable<ComputedResult, "id">;
  budgets!: EntityTable<Budget, "id">;
  budget_lines!: EntityTable<BudgetLine, "id">;
  settings!: EntityTable<Setting, "key">;
  goals!: EntityTable<Goal, "id">;
  goal_events!: EntityTable<GoalEvent, "id">;
  server_queue!: EntityTable<ServerQueueItem, "id">;
  recurring_series!: EntityTable<RecurringSeries, "id">;
  forecasts!: EntityTable<ForecastRow, "id">;
  receipts!: EntityTable<Receipt, "id">;
  debts!: EntityTable<Debt, "id">;
  emergency_fund!: EntityTable<EmergencyFund, "id">;
  tombstones!: Table<Tombstone, [string, string]>; // compound key [table+id]
  goal_milestones!: EntityTable<GoalMilestone, "id">;
  goal_templates!: EntityTable<GoalTemplate, "id">;
  card_details!: EntityTable<CardDetail, "account_id">;
  card_due_dates!: EntityTable<CardDueDate, "id">;
  net_worth_items!: EntityTable<NetWorthItem, "id">;
  net_worth_snapshots!: EntityTable<NetWorthSnapshot, "month">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      accounts: "id, type",
      categories: "id, kind, [kind+sort]",
      entries: "id, date, account_id, category_id, [account_id+date], &[account_id+fingerprint]",
    });
    // 1.3b statement import
    this.version(2).stores({
      accounts: "id, type, created_at",
      statement_imports: "id, account_id, created_at",
      csv_mappings: "account_id",
      balance_anchors: "id, account_id, [account_id+as_of]",
      merchant_rules: "id, category_id",
      files: "id, kind, import_id",
    });
    // 1.3c money in & out
    this.version(3).stores({
      computed_results: "id, kind, [kind+as_of]",
    });
    // 1.4 budget
    this.version(4).stores({
      budgets: "id, &month",
      budget_lines: "id, budget_id, [budget_id+category_id]",
      settings: "key",
    });
    // 1.5 goals
    this.version(5).stores({
      goals: "id, kind, status, group_id",
      goal_events: "id, goal_id, [goal_id+date]",
    });
    // 1.6 groups: the only money-adjacent thing that leaves the device is a percentage
    this.version(6).stores({
      server_queue: "id, kind, created_at",
    });
    // 1.7 upcoming + forecast
    this.version(7).stores({
      recurring_series: "id, status, kind, [payee+kind]",
      forecasts: "id, as_of",
    });
    // 1.9 receipts: photos on the device only
    this.version(8).stores({
      receipts: "id, entry_id, file_id, purge_after",
    });
    // 1.10 bills & debt, emergency fund as a jar
    this.version(9).stores({
      debts: "id, apr_bps",
      emergency_fund: "id",
    });
    // 1.16 encrypted sync + couples: deletions remembered, jars shared with a household
    this.version(10).stores({
      goals: "id, kind, status, group_id, household_id",
      tombstones: "[table+id], deleted_at",
    });
    // fast-follow 3: custom-goal extras
    this.version(11).stores({
      goals: "id, kind, status, group_id, household_id, priority",
      goal_milestones: "id, goal_id",
      goal_templates: "id, created_at",
    });
    // Chunk 3.3: linked transactions are found by the provider's id (modified / removed / posted).
    this.version(12).stores({
      entries:
        "id, date, account_id, category_id, provider_txn_id, [account_id+date], &[account_id+fingerprint]",
    });
    // Chunk 3.5: linked cards' statement facts.
    this.version(13).stores({ card_details: "account_id" });
    // Net worth (October 19, 2026): hand-added items and per-account choices, monthly totals.
    this.version(14).stores({
      net_worth_items: "id, source, ref_id",
      net_worth_snapshots: "month",
    });
    // Tags and notes on entries (October 19, 2026): entries are found by tag.
    this.version(15).stores({
      entries:
        "id, date, account_id, category_id, provider_txn_id, *tags, [account_id+date], &[account_id+fingerprint]",
    });
    // Rename all like this (October 20, 2026): names by cleaned bank text.
    this.version(16).stores({ merchant_names: "id, &match" });
    // Credit habits (October 28, 2026): linked cards' due dates as they were seen.
    this.version(17).stores({ card_due_dates: "id, account_id" });
    // Own subscription kinds and words (October 29, 2026): a word once, found by its kind.
    this.version(18).stores({
      own_subscription_kinds: "id",
      own_subscription_words: "id, &match, kind",
    });
  }
}

export function dbName(userId: string): string {
  return `stackd-${userId}`;
}

const open = new Map<string, StackdDb>();

/** The user's database, opened once per session. */
export function openDb(userId: string): StackdDb {
  let db = open.get(userId);
  if (!db) {
    db = new StackdDb(dbName(userId));
    open.set(userId, db);
  }
  return db;
}

export function closeDb(userId: string): void {
  open.get(userId)?.close();
  open.delete(userId);
}

/**
 * For background work that may outlive the database (sign-out, deletion, test teardown): a
 * closed database is not an error worth reporting; anything else still surfaces.
 */
export function ignoreClosed(error: unknown): void {
  if (error instanceof Error && error.name === "DatabaseClosedError") return;
  throw error;
}

/** Account deletion (chunk 1.11) wipes the device copy with this. */
export async function deleteDb(userId: string): Promise<void> {
  closeDb(userId);
  await Dexie.delete(dbName(userId));
}

/** Idempotent: adds the default categories and the cash account if they are missing. */
export async function seedDefaults(db: StackdDb, now: Date = new Date()): Promise<void> {
  await db.transaction("rw", db.accounts, db.categories, async () => {
    const haveCategories = new Set((await db.categories.toCollection().primaryKeys()) as string[]);
    const missing = DEFAULT_CATEGORIES.filter((c) => !haveCategories.has(c.id));
    if (missing.length) await db.categories.bulkAdd(missing);
    if (!(await db.accounts.get(DEFAULT_ACCOUNT.id))) {
      await db.accounts.add({ ...DEFAULT_ACCOUNT, created_at: now.toISOString() });
    }
  });
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * The entries that count toward spending totals (In / Out / Kept, budgets, categories, insights,
 * the recap, typical spending). "Don't count" entries stay in balances and net worth.
 */
export function counted<T extends { not_counted?: boolean }>(entries: T[]): T[] {
  return entries.filter((e) => !e.not_counted);
}

/**
 * The text a merchant is matched on (invariant 47, October 29, 2026): the bank's own cleaned
 * text, never a name the person gave the entry, so renaming "NETFLIX.COM" to "Netflix" keeps it
 * on its bill, its subscription and its saved name. An entry typed by hand has only its name.
 */
export function bankText(e: Pick<Entry, "clean_description" | "merchant">): string {
  return e.clean_description || e.merchant;
}

/** Entries dated inside [start, end], newest first then newest-created first. */
export async function entriesBetween(db: StackdDb, start: string, end: string): Promise<Entry[]> {
  const rows = await db.entries.where("date").between(start, end, true, true).toArray();
  return rows.sort((a, b) =>
    a.date === b.date ? compareText(b.created_at, a.created_at) : compareText(b.date, a.date),
  );
}
