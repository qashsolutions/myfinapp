/**
 * Typed calls into the rules engine. Every number the app shows comes through here, carrying
 * the `rules_version` that produced it (docs/spec.md "Proving determinism").
 *
 * The engine runs in a Web Worker; where workers are unavailable (tests, very old browsers)
 * the same code runs inline, so results are identical either way.
 */

import type { EngineRequest, EngineResponse } from "@stackd/rules/engine";
import { answer } from "./answer.ts";

export class EngineError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EngineError";
  }
}

export interface Transport {
  post(request: EngineRequest): void;
  onMessage(listener: (response: EngineResponse) => void): void;
  terminate(): void;
}

/** The worker as bridge.ts uses it: enough of `Worker` for a test to fake one. */
export interface WorkerLike {
  postMessage(request: EngineRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<EngineResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

const newEngineWorker = (): WorkerLike =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

/**
 * The engine in a Web Worker. If the worker fails to load (a missing chunk after an update, a
 * blocked script, no network) or errors, it is dropped and the engine runs inline from then on,
 * with every unanswered call sent again there, so no screen waits forever for a number.
 */
export function createWorkerTransport(make: () => WorkerLike = newEngineWorker): Transport {
  let listener: ((response: EngineResponse) => void) | null = null;
  const unanswered = new Map<number, EngineRequest>();
  let inline: Transport | null = null;
  let worker: WorkerLike | null = null;
  // A worker that has answered and then crashes is replaced by a fresh one (a few times), so
  // heavy calls stay off the page; one that never loads goes inline at once (October 27, 2026).
  let answered = false;
  let restarts = 0;

  const drop = () => {
    if (!worker) return;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    worker = null;
  };

  const toInline = () => {
    if (inline) return;
    drop();
    inline = createInlineTransport();
    inline.onMessage((r) => listener?.(r));
    const again = [...unanswered.values()];
    unanswered.clear();
    for (const request of again) inline.post(request);
  };

  const failed = () => {
    if (answered && restarts < MAX_RESTARTS) {
      restarts += 1;
      drop();
      if (start()) for (const request of unanswered.values()) worker?.postMessage(request);
      return;
    }
    toInline();
  };

  const start = (): boolean => {
    try {
      const w = make();
      w.onmessage = (e) => {
        answered = true;
        unanswered.delete(e.data.id);
        listener?.(e.data);
      };
      w.onerror = (e) => {
        e.preventDefault();
        failed();
      };
      w.onmessageerror = () => failed();
      worker = w;
      return true;
    } catch {
      toInline();
      return false;
    }
  };

  start();

  return {
    post: (request) => {
      if (!worker) toInline();
      if (inline) return inline.post(request);
      if (!worker) return;
      unanswered.set(request.id, request);
      worker.postMessage(request);
    },
    onMessage: (l) => {
      listener = l;
    },
    terminate: () => {
      worker?.terminate();
      inline?.terminate();
      unanswered.clear();
    },
  };
}

const MAX_RESTARTS = 3;

/** Runs the engine on the calling thread; identical answers, no worker. */
export function createInlineTransport(): Transport {
  let listener: ((response: EngineResponse) => void) | null = null;
  return {
    post: (request) => {
      const response = answer(request); // a bug rather than bad input fails just this call
      queueMicrotask(() => listener?.(response));
    },
    onMessage: (l) => {
      listener = l;
    },
    terminate: () => {
      listener = null;
    },
  };
}

type Json = Record<string, unknown>;
type Result = object;

export class Engine {
  private next = 1;
  private pending = new Map<number, { resolve: (v: Result) => void; reject: (e: Error) => void }>();
  /** The rules_version of the last answer; stamped on stored results. */
  rulesVersion: string | null = null;

  constructor(private readonly transport: Transport) {
    transport.onMessage((response) => {
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      this.pending.delete(response.id);
      this.rulesVersion = response.rules_version;
      if (response.ok) waiting.resolve(response.result);
      else waiting.reject(new EngineError(response.error));
    });
  }

  call<T extends Result = Json>(rule: string, input: Json): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.transport.post({ id, rule, input });
    });
  }

  terminate(): void {
    this.transport.terminate();
    this.pending.clear();
  }
}

export function createEngine(): Engine {
  return new Engine(
    typeof Worker === "undefined" ? createInlineTransport() : createWorkerTransport(),
  );
}

export const engine: Engine = createEngine();

// Typed wrappers for the rules that exist today (money, dates). Later chunks add
// cashflow, budget, forecast, goals… next to their rule files.

/** "$1,234.56" → 123456 cents; throws EngineError("invalid_amount"). */
export async function parseAmount(text: string): Promise<number> {
  const { cents } = await engine.call<{ cents: number }>("money.parse_amount", { text });
  return cents;
}

export interface MonthBounds {
  start: string;
  end: string;
}

export async function monthBounds(asOf: string): Promise<MonthBounds> {
  return engine.call<MonthBounds>("dates.month_bounds", { as_of: asOf });
}

/** dates.days_until: whole days from `asOf` to `date` (negative when it's past). */
export async function daysUntil(asOf: string, date: string): Promise<number> {
  const { days } = await engine.call<{ days: number }>("dates.days_until", { as_of: asOf, date });
  return days;
}

export async function addMonths(date: string, months: number): Promise<string> {
  const { date: result } = await engine.call<{ date: string }>("dates.add_months", {
    date,
    months,
  });
  return result;
}

// cashflow (chunk 1.3c)

export interface RuleEntry {
  id: string;
  date: string;
  amount_cents: number;
  direction: "in" | "out";
  is_transfer: boolean;
  category_id: string | null;
  category_kind: "expense" | "income" | null;
  account_id: string;
}

export interface MonthTotals {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  net_cents: number;
  transfers_out_cents: number;
  count: number;
  by_category: Array<{ category_id: string | null; out_cents: number }>;
  by_account: Array<{ account_id: string; in_cents: number; out_cents: number }>;
}

export async function monthTotals(asOf: string, entries: RuleEntry[]): Promise<MonthTotals> {
  return engine.call<MonthTotals>("cashflow.month_totals", { as_of: asOf, entries });
}

/** The same totals between two dates inclusive (fast-follow 6: the weekly recap's week). */
export async function periodTotals(
  start: string,
  end: string,
  entries: RuleEntry[],
): Promise<MonthTotals> {
  return engine.call<MonthTotals>("cashflow.period_totals", { start, end, entries });
}

// Fixed vs flexible (October 28, 2026): a rule entry plus its run mark and its category's bucket.
export interface FlexRuleEntry extends RuleEntry {
  is_recurring: boolean;
  bucket: "need" | "want" | "save" | null;
}

export interface BucketCents {
  need: number;
  want: number;
  save: number;
  none: number;
}

export interface FixedFlexible {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  fixed_cents: number;
  flexible_cents: number;
  fixed_by_bucket: BucketCents;
  flexible_by_bucket: BucketCents;
  kept_cents: number;
  kept_rate_bps: number | null;
  by_category: Array<{
    category_id: string | null;
    bucket: "need" | "want" | "save" | null;
    fixed_cents: number;
    flexible_cents: number;
    out_cents: number;
  }>;
  room: Array<{ category_id: string | null; flexible_cents: number }>;
}

export async function fixedFlexible(
  start: string,
  end: string,
  entries: FlexRuleEntry[],
): Promise<FixedFlexible> {
  return engine.call<FixedFlexible>("cashflow.fixed_flexible", { start, end, entries });
}

// Time ranges (October 20, 2026): a range split into weeks, months or quarters.
export type SeriesStepKind = "week" | "month" | "quarter";

export interface SeriesStep {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  net_cents: number;
  count: number;
}

export interface Series {
  start: string;
  end: string;
  step: SeriesStepKind;
  steps: SeriesStep[];
  in_cents: number;
  out_cents: number;
  net_cents: number;
  count: number;
  by_category: Array<{ category_id: string | null; out_cents: number }>;
  active_months: number;
  avg_in_cents: number | null;
  avg_out_cents: number | null;
  avg_net_cents: number | null;
  first_date: string | null;
}

export async function cashSeries(
  start: string,
  end: string,
  step: SeriesStepKind,
  entries: RuleEntry[],
): Promise<Series> {
  return engine.call<Series>("cashflow.series", { start, end, step, entries });
}

export async function netChange(netCents: number, previousNetCents: number): Promise<number> {
  const { delta_cents } = await engine.call<{ delta_cents: number }>("cashflow.net_change", {
    net_cents: netCents,
    previous_net_cents: previousNetCents,
  });
  return delta_cents;
}

export interface TransferPair {
  out_id: string;
  in_id: string;
  days_apart: number;
}

export async function matchTransfers(
  entries: RuleEntry[],
  windowDays = 5,
): Promise<TransferPair[]> {
  const { pairs } = await engine.call<{ pairs: TransferPair[] }>("cashflow.match_transfers", {
    entries,
    window_days: windowDays,
  });
  return pairs;
}

// budget (chunk 1.4)

export type Bucket = "need" | "want" | "save";

export async function budgetTargets(
  takeHomeCents: number,
  splitBps: Record<Bucket, number> | null = null,
): Promise<Record<Bucket, number>> {
  if (splitBps)
    return engine.call<Record<Bucket, number>>("budget.targets_split", {
      take_home_cents: takeHomeCents,
      split_bps: splitBps,
    });
  return engine.call<Record<Bucket, number>>("budget.targets_50_30_20", {
    take_home_cents: takeHomeCents,
  });
}

export async function monthlyTakeHome(amountCents: number, frequency: string): Promise<number> {
  const { cents } = await engine.call<{ cents: number }>("budget.monthly_take_home", {
    amount_cents: amountCents,
    frequency,
  });
  return cents;
}

export interface BudgetRuleEntry {
  date: string;
  amount_cents: number;
  direction: "in" | "out";
  is_transfer: boolean;
  category_id: string | null;
  bucket: Bucket | null;
}

export interface BudgetRuleLine {
  category_id: string;
  bucket: Bucket | null;
  planned_cents: number;
}

export interface BudgetSummary {
  start: string;
  end: string;
  method: string;
  take_home_cents: number;
  buckets: Array<{
    bucket: Bucket;
    planned_cents: number;
    spent_cents: number;
    left_cents: number;
  }>;
  categories: Array<{
    category_id: string;
    bucket: Bucket | null;
    planned_cents: number | null;
    spent_cents: number;
  }>;
  uncategorized_cents: number;
  total_spent_cents: number;
  left_to_assign_cents: number | null;
  kept_cents: number;
}

export async function budgetSummary(
  asOf: string,
  method: string,
  takeHomeCents: number,
  lines: BudgetRuleLine[],
  entries: BudgetRuleEntry[],
  splitBps: Record<Bucket, number> | null = null,
): Promise<BudgetSummary> {
  return engine.call<BudgetSummary>("budget.summary", {
    as_of: asOf,
    method,
    take_home_cents: takeHomeCents,
    lines,
    entries,
    ...(splitBps ? { split_bps: splitBps } : {}),
  });
}

/** money.round_div: the one half-even division, for averages shown on screen. */
export async function roundDiv(numerator: number, denominator: number): Promise<number> {
  const { cents } = await engine.call<{ cents: number }>("money.round_div", {
    numerator,
    denominator,
  });
  return cents;
}

export async function ratioBps(part: number, whole: number): Promise<number | null> {
  const { bps } = await engine.call<{ bps: number | null }>("money.ratio_bps", { part, whole });
  return bps;
}

// goals (chunk 1.5)

export interface GoalRuleInput {
  kind: string;
  target_cents?: number | null;
  target_days?: number | null;
  start_date: string;
  end_date: string | null;
  baseline_cents?: number | null;
  period_spend_cents?: number | null;
}

export interface GoalEventInput {
  type: "deposit" | "withdrawal" | "balance_update" | "checkin";
  date: string;
  amount_cents?: number | null;
}

export interface GoalProgress {
  kind: string;
  current: number;
  target: number;
  remaining: number;
  progress_bps: number | null;
  display_bps: number;
  days_left: number | null;
  weeks_left: number | null;
  weekly_pace: number | null;
  status: "reached" | "overdue" | "active";
  end_date: string | null;
}

export async function goalProgress(
  goal: GoalRuleInput,
  events: GoalEventInput[],
  asOf: string,
): Promise<GoalProgress> {
  return engine.call<GoalProgress>("goals.progress", { goal, events, as_of: asOf });
}

// fast-follow 3: cadence plan, ongoing streak, milestones

export interface GoalPlanInput {
  kind: string;
  target_cents: number | null;
  start_date: string;
  end_date: string | null;
  cadence: string;
  per_period_cents?: number | null;
}

export interface GoalPlan {
  remaining_cents: number;
  periods_left: number | null;
  per_period_cents: number | null;
  finish_date: string | null;
  next_date: string;
  needs_amount: boolean;
}

export async function goalPlan(
  goal: GoalPlanInput,
  events: GoalEventInput[],
  asOf: string,
  schedule: PaySchedule | null = null,
): Promise<GoalPlan> {
  return engine.call<GoalPlan>("goals_custom.plan", { goal, events, as_of: asOf, schedule });
}

export interface GoalStreak {
  total_cents: number;
  streak: number;
  periods_complete: number;
  current: { start: string; end: string; saved_cents: number; met: boolean; paused: boolean };
}

export async function goalStreak(
  goal: {
    kind: string;
    start_date: string;
    cadence: string;
    per_period_cents: number;
    pauses?: Array<{ start: string; end: string | null }>;
  },
  events: GoalEventInput[],
  asOf: string,
  schedule: PaySchedule | null = null,
): Promise<GoalStreak> {
  return engine.call<GoalStreak>("goals_custom.streak", { goal, events, as_of: asOf, schedule });
}

export interface MilestoneResult {
  bps: number;
  target_cents: number;
  reached: boolean;
}

export async function goalMilestones(
  targetCents: number,
  currentCents: number,
  checkpointsBps: number[],
): Promise<MilestoneResult[]> {
  const { milestones } = await engine.call<{ milestones: MilestoneResult[] }>(
    "goals_custom.milestones",
    { target_cents: targetCents, current_cents: currentCents, checkpoints_bps: checkpointsBps },
  );
  return milestones;
}

export async function spendLessBaseline(
  estimateCents: number,
  previousMonthsCents: number[],
): Promise<number> {
  const { baseline_cents } = await engine.call<{ baseline_cents: number }>(
    "goals.spend_less_baseline",
    {
      estimate_cents: estimateCents,
      previous_months_cents: previousMonthsCents,
    },
  );
  return baseline_cents;
}

export interface CustomJar {
  goal: {
    kind: "save";
    title: string;
    target_cents: number;
    start_date: string;
    end_date: string | null;
  };
  days_left: number | null;
  weeks_left: number | null;
  weekly_pace: number | null;
}

/** A jar with the user's own name, amount and date; throws `EngineError` with the rule's code. */
export async function customJar(
  name: string,
  targetCents: number,
  endDate: string | null,
  asOf: string,
): Promise<CustomJar> {
  return engine.call<CustomJar>("goals_custom.jar", {
    name,
    target_cents: targetCents,
    end_date: endDate,
    as_of: asOf,
  });
}

export interface RankMemberInput {
  id: string;
  progress_bps: number;
  reached_at: string | null;
  has_events: boolean;
}

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

/** Leaderboard order: percent of own target, ties by earliest reach; no events yet = hidden. */
export async function rankMembers(members: RankMemberInput[]): Promise<Ranking> {
  return engine.call<Ranking>("groups.rank", { members });
}

// household (chunk 1.16)

export interface ContributionEvent {
  member_id: string;
  type: "deposit" | "withdrawal" | "balance_update" | "checkin";
  amount_cents: number | null;
}

export interface Split {
  contributions: Array<{ member_id: string; cents: number }>;
  total_cents: number;
}

/** A shared jar split by who deposited what; leaving keeps each member's own part. */
export async function splitContributions(
  events: ContributionEvent[],
  members: string[],
): Promise<Split> {
  return engine.call<Split>("household.split_contributions", { events, members });
}

export interface CombinedTotals {
  in_cents: number;
  out_cents: number;
  net_cents: number;
  members: number;
}

/** The household's In / Out / Net from each member's month totals; totals only. */
export async function combineTotals(
  summaries: Array<{ member_id: string; in_cents: number; out_cents: number }>,
): Promise<CombinedTotals> {
  return engine.call<CombinedTotals>("household.combine_totals", { summaries });
}

export type PaySchedule =
  | { kind: "every_n_days"; anchor: string; n: number }
  | { kind: "monthly_days"; days: number[] };

/** Cadence periods from `asOf` until `deadline` (0 when the deadline is not ahead). */
export async function periodsUntil(
  asOf: string,
  deadline: string,
  cadence: string,
  schedule: PaySchedule | null = null,
): Promise<number> {
  const { periods } = await engine.call<{ periods: number }>("dates.periods_until", {
    as_of: asOf,
    deadline,
    cadence,
    schedule,
  });
  return periods;
}

export async function nextPaydays(
  asOf: string,
  schedule: PaySchedule,
  count: number,
): Promise<string[]> {
  const { dates } = await engine.call<{ dates: string[] }>("dates.next_paydays", {
    as_of: asOf,
    schedule,
    count,
  });
  return dates;
}

export interface RecurringRuleEntry {
  id: string;
  date: string;
  amount_cents: number;
  direction: "in" | "out";
  is_transfer: boolean;
  payee: string;
}

export interface DetectedSeries {
  payee: string;
  kind: "bill" | "income";
  direction: "in" | "out";
  expected_cents: number;
  interval: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  last_date: string;
  next_date: string;
  occurrences: number;
  entry_ids: string[];
}

export async function detectRecurring(
  entries: RecurringRuleEntry[],
  asOf: string,
): Promise<DetectedSeries[]> {
  const { series } = await engine.call<{ series: DetectedSeries[] }>("recurring.detect", {
    entries,
    as_of: asOf,
  });
  return series;
}

export interface YearlyCostItem {
  id: string;
  label: string;
  yearly_cents: number;
  monthly_cents: number;
}

export interface YearlyCost {
  items: YearlyCostItem[];
  yearly_cents: number;
  monthly_cents: number;
}

/** recurring.yearly_cost: each recurring charge's cost a year and a month, highest first. */
export async function yearlyCost(
  series: Array<{ id: string; label: string; interval: string; expected_cents: number }>,
): Promise<YearlyCost> {
  return engine.call<YearlyCost>("recurring.yearly_cost", { series });
}

// Subscription check (October 28, 2026): facts from the person's own charges, and when to ask.
export interface SubscriptionCheckInput {
  id: string;
  label: string;
  payee: string;
  interval: string;
  expected_cents: number;
  next_date: string;
  checked_at: string | null;
  charges: Array<{ date: string; cents: number }>;
}

export interface SubscriptionCheckItem {
  id: string;
  label: string;
  kind: string | null;
  ask: boolean;
  price_rise: { from_cents: number; to_cents: number; date: string } | null;
  renewal: { date: string; cents: number } | null;
  trial_turned_charge: { trial_cents: number; cents: number; date: string } | null;
  yearly_cents: number;
  monthly_cents: number;
}

export interface SubscriptionCheck {
  items: SubscriptionCheckItem[];
  duplicates: Array<{ kind: string; count: number; monthly_total_cents: number; ids: string[] }>;
}

export async function subscriptionCheck(
  asOf: string,
  subscriptions: SubscriptionCheckInput[],
  kinds: Array<{ match: string; kind: string }>,
  thresholds: Record<string, number>,
): Promise<SubscriptionCheck> {
  return engine.call<SubscriptionCheck>("recurring.subscription_check", {
    as_of: asOf,
    subscriptions,
    kinds,
    thresholds,
  });
}

export interface SpendingRuleEntry {
  date: string;
  amount_cents: number;
  direction: "in" | "out";
  is_transfer: boolean;
  is_recurring: boolean;
}

export interface TypicalDaily {
  cents_per_day: number;
  basis: "history" | "budget" | "none";
  days_of_history: number;
}

export async function typicalDailySpending(
  entries: SpendingRuleEntry[],
  asOf: string,
  fallbackMonthlyCents: number,
): Promise<TypicalDaily> {
  return engine.call<TypicalDaily>("forecast.typical_daily_spending", {
    entries,
    as_of: asOf,
    fallback_monthly_cents: fallbackMonthlyCents,
  });
}

export interface StartBalance {
  balance_cents: number | null;
  as_of: string | null;
  entries_since: number;
}

export async function startBalance(
  anchor: { as_of: string; balance_cents: number } | null,
  entries: Array<{ date: string; amount_cents: number; direction: "in" | "out" }>,
): Promise<StartBalance> {
  return engine.call<StartBalance>("forecast.start_balance", { anchor, entries });
}

export interface SeriesInput {
  id: string;
  payee: string;
  kind: "bill" | "income";
  expected_cents: number;
  interval: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  next_date: string;
  /** The day of the month a monthly series keeps (31 = the last day); forecast.upcoming. */
  day?: number;
}

export interface UpcomingItem {
  date: string;
  series_id: string;
  payee: string;
  kind: "bill" | "income";
  amount_cents: number;
  matched: boolean;
  entry_id: string | null;
}

export interface Upcoming {
  start: string;
  end: string;
  items: UpcomingItem[];
}

export async function upcomingItems(
  series: SeriesInput[],
  entries: RecurringRuleEntry[],
  asOf: string,
  days: number,
): Promise<Upcoming> {
  return engine.call<Upcoming>("forecast.upcoming", { series, entries, as_of: asOf, days });
}

export interface Projection {
  days: Array<{ date: string; balance_cents: number }>;
  lowest_cents: number;
  lowest_date: string;
  end_cents: number;
  shortfall: boolean;
  short_by_cents: number;
  first_short_date: string | null;
}

export async function projectBalance(
  asOf: string,
  startBalanceCents: number,
  dailyCents: number,
  upcoming: UpcomingItem[],
  bufferCents: number,
  days: number,
): Promise<Projection> {
  return engine.call<Projection>("forecast.project", {
    as_of: asOf,
    start_balance_cents: startBalanceCents,
    daily_cents: dailyCents,
    upcoming,
    buffer_cents: bufferCents,
    days,
  });
}

/** Merchant text the way the rules compare it: trimmed, single spaces, ASCII upper-case. */
export async function cleanDescription(text: string): Promise<string> {
  const { text: cleaned } = await engine.call<{ text: string }>("fingerprint.clean_description", {
    text,
  });
  return cleaned;
}

export async function addDays(date: string, days: number): Promise<string> {
  const r = await engine.call<{ date: string }>("dates.add_days", { date, days });
  return r.date;
}

export async function pctOf(cents: number, bps: number): Promise<number> {
  const r = await engine.call<{ cents: number }>("money.pct_of", { cents, bps });
  return r.cents;
}

export interface NextMoveFacts {
  shortfall: { short_by_cents: number; date: string } | null;
  take_home_cents: number | null;
  payday: {
    paycheck_cents: number;
    suggested_cents: number;
    set_aside_this_period: boolean;
  } | null;
  emergency_saved_cents: number | null;
  max_apr_bps: number | null;
  next_bill: { label: string; date: string; amount_cents: number } | null;
  runway_tenths: number | null;
  behind_goal?: {
    id: string;
    title: string;
    per_period_cents: number;
    behind_cents: number;
  } | null;
}

export interface NextMove {
  id:
    | "shortfall"
    | "set_pay"
    | "payday_set_aside"
    | "starter_fund"
    | "high_apr"
    | "bill_due"
    | "grow_runway"
    | "goal_behind_pace"
    | "start_goal";
  params: Record<string, unknown>;
}

export interface NextMoveConfig {
  version: number;
  order: string[];
  thresholds: Record<string, number>;
}

export async function nextMove(
  facts: NextMoveFacts,
  config: NextMoveConfig,
  asOf: string,
): Promise<NextMove> {
  return engine.call<NextMove>("next_move.pick", { facts, config, as_of: asOf });
}

export interface SetAside {
  set_aside_cents: number;
  target_cents: number | null;
  progress_bps: number | null;
  paydays: Array<{ date: string; set_aside: boolean; due: boolean }>;
  paydays_so_far: number;
  paydays_set_aside: number;
}

export async function setAside(
  deposits: Array<{ date: string; amount_cents: number }>,
  asOf: string,
  targetCents: number | null,
  paydays: string[],
): Promise<SetAside> {
  return engine.call<SetAside>("next_move.set_aside", {
    deposits,
    as_of: asOf,
    target_cents: targetCents,
    paydays,
  });
}

export async function paydayNudge(
  paycheckCents: number,
  targetCents: number | null,
  monthlyTakeHomeCents: number,
  shareBps: number,
): Promise<number> {
  const r = await engine.call<{ cents: number }>("next_move.payday_nudge", {
    paycheck_cents: paycheckCents,
    target_cents: targetCents,
    monthly_take_home_cents: monthlyTakeHomeCents,
    share_bps: shareBps,
  });
  return r.cents;
}

export interface EmergencyMilestone {
  key: "starter" | "one_month" | "target";
  target_cents: number;
  progress_bps: number;
  reached: boolean;
  eta_months: number | null;
  months?: number;
}

export interface EmergencySummary {
  saved_cents: number;
  essentials_cents: number;
  runway_tenths: number | null;
  target_months: number;
  monthly_plan_cents: number;
  milestones: EmergencyMilestone[];
}

export interface NetWorthInputItem {
  id: string;
  kind: "asset" | "debt";
  group: string;
  value_cents: number;
}

export interface NetWorthSummary {
  assets_cents: number;
  debts_cents: number;
  net_cents: number;
  debt_share_bps: number | null;
  change_cents: number | null;
  groups: Array<{ kind: "asset" | "debt"; group: string; total_cents: number; count: number }>;
}

/** networth.summary: what you own minus what you owe (October 19, 2026). */
export async function netWorthSummary(
  items: NetWorthInputItem[],
  previousNetCents: number | null,
): Promise<NetWorthSummary> {
  return engine.call<NetWorthSummary>("networth.summary", {
    items,
    previous_net_cents: previousNetCents,
  });
}

export interface TopSpending {
  largest: Array<{ id: string; date: string; amount_cents: number; payee: string | null }>;
  merchants: Array<{
    key: string;
    name: string;
    count: number;
    total_cents: number;
    last_date: string;
  }>;
  count: number;
}

/** insights.top_spending: the biggest amounts out and the merchants paid most often. */
export async function topSpending(
  start: string,
  end: string,
  entries: Array<{
    id: string;
    date: string;
    amount_cents: number;
    direction: "in" | "out";
    is_transfer: boolean;
    payee: string | null;
  }>,
  limit: number,
): Promise<TopSpending> {
  return engine.call<TopSpending>("insights.top_spending", { start, end, entries, limit });
}

export interface NetWorthHistoryAccount {
  id: string;
  anchors: Array<{ as_of: string; balance_cents: number }>;
  entries: Array<{ date: string; amount_cents: number; direction: "in" | "out" }>;
}

export interface NetWorthPoint {
  date: string;
  assets_cents: number | null;
  debts_cents: number | null;
  net_cents: number | null;
  partial: boolean;
}

/** networth.history: net worth on each date, rebuilt from balance points and entries. */
export async function netWorthHistory(
  dates: string[],
  accounts: NetWorthHistoryAccount[],
  items: Array<{ id: string; kind: "asset" | "debt"; value_cents: number; since: string }>,
): Promise<{ points: NetWorthPoint[]; change_cents: number | null }> {
  return engine.call<{ points: NetWorthPoint[]; change_cents: number | null }>("networth.history", {
    dates,
    accounts,
    items,
  });
}

export async function emergencySummary(
  savedCents: number,
  essentialsCents: number,
  targetMonths: number,
  monthlyPlanCents: number,
): Promise<EmergencySummary> {
  return engine.call<EmergencySummary>("emergency.summary", {
    saved_cents: savedCents,
    essentials_cents: essentialsCents,
    target_months: targetMonths,
    monthly_plan_cents: monthlyPlanCents,
  });
}

export interface DebtInput {
  id: string;
  label: string;
  balance_cents: number;
  apr_bps: number;
  min_payment_cents: number;
}

export interface AvalancheOrder {
  order: Array<DebtInput & { rank: number }>;
  total_balance_cents: number;
  total_min_payment_cents: number;
  max_apr_bps: number | null;
}

export async function avalancheOrder(debts: DebtInput[]): Promise<AvalancheOrder> {
  return engine.call<AvalancheOrder>("bills.avalanche_order", { debts });
}

export interface PayoffDebt {
  id: string;
  label: string;
  rank: number;
  payoff_month: string | null; // YYYY-MM
  months: number | null;
  interest_cents: number | null;
}

export interface PayoffPlan {
  stalled: boolean;
  months: number | null;
  debt_free_month: string | null;
  monthly_budget_cents: number;
  total_interest_cents: number | null;
  total_paid_cents: number | null;
  series_cents: number[];
  order: PayoffDebt[];
}

/** The avalanche month by month with a fixed budget of every minimum plus `extraCents` (fast-follow 1). */
export async function payoffPlan(
  debts: DebtInput[],
  extraCents: number,
  asOf: string,
): Promise<PayoffPlan> {
  return engine.call<PayoffPlan>("bills.payoff_plan", {
    debts,
    extra_cents: extraCents,
    as_of: asOf,
  });
}

export interface LaterProjection {
  years: number;
  points: Array<{ age: number; contributed_cents: number; balances_cents: number[] }>;
  at_retirement_cents: number[];
  middle_index: number;
  target_cents: number;
  reaches_target: boolean | null;
  monthly_needed_cents: number | null;
}

/** growth.projection: savings by age at up to three rates the person sets (October 25, 2026). */
export async function growthProjection(input: {
  age_now: number;
  retire_age: number;
  start_cents: number;
  monthly_cents: number;
  rates_bps: number[];
  target_cents: number;
}): Promise<LaterProjection> {
  return engine.call<LaterProjection>("growth.projection", input);
}

export interface GrowPlan {
  months: number;
  cost_months: number;
  future_cost_cents: number;
  saved_grows_to_cents: number;
  monthly_needed_cents: number;
  already_enough: boolean;
}

/** growth.goal_plan: a jar whose cost rises while what's saved grows (October 28, 2026). */
export async function growGoalPlan(input: {
  today_cost_cents: number;
  cost_rise_bps: number;
  return_bps: number;
  saved_cents: number;
  as_of: string;
  target_date: string;
  priced_on?: string | null;
}): Promise<GrowPlan> {
  return engine.call<GrowPlan>("growth.goal_plan", input);
}

export interface GrowPace {
  months_in: number;
  expected_cents: number;
  status: "ahead" | "on_track" | "behind";
}

/** growth.goal_pace: deposits so far against the plan's monthly amount. */
export async function growGoalPace(input: {
  plan_monthly_cents: number;
  deposited_cents: number;
  start_date: string;
  as_of: string;
}): Promise<GrowPace> {
  return engine.call<GrowPace>("growth.goal_pace", input);
}

export interface WhatIfSide {
  months: number | null;
  debt_free_month: string | null;
  interest_cents: number | null;
}

export interface WhatIfDebt {
  before: WhatIfSide;
  after: WhatIfSide;
  months_sooner: number | null;
  interest_saved_cents: number | null;
  status: "sooner" | "same" | "stalled";
}

/** whatif.debt: the payoff plan with today's extra, then with `addCents` more a month. */
export async function whatIfDebt(
  debts: DebtInput[],
  extraCents: number,
  addCents: number,
  asOf: string,
): Promise<WhatIfDebt> {
  return engine.call<WhatIfDebt>("whatif.debt", {
    debts,
    extra_cents: extraCents,
    add_cents: addCents,
    as_of: asOf,
  });
}

export interface WhatIfGoal {
  months_now: number | null;
  months_new: number | null;
  finish_now: string | null; // YYYY-MM
  finish_new: string | null;
  months_sooner: number | null;
  status: "sooner" | "same" | "never";
}

/** whatif.goal: months to fill a jar at today's pace and with `addCents` more a month. */
export async function whatIfGoal(
  remainingCents: number,
  perMonthCents: number,
  addCents: number,
  asOf: string,
): Promise<WhatIfGoal> {
  return engine.call<WhatIfGoal>("whatif.goal", {
    remaining_cents: remainingCents,
    per_month_cents: perMonthCents,
    add_cents: addCents,
    as_of: asOf,
  });
}

export interface AlertInputs {
  now_local: string;
  upcoming: Array<{ series_id: string; date: string; kind: "bill" | "income"; matched: boolean }>;
  shortfall: { first_short_date: string; short_by_cents: number } | null;
  challenges: Array<{ group_id: string; end_date: string }>;
  goals: Array<{
    id: string;
    kind: "save";
    start_date: string;
    end_date: string;
    target_cents: number;
    current_cents: number;
  }>;
  milestones: Array<{ goal_id: string; key: string }>;
  prefs: Record<
    string,
    { enabled: boolean; lead_days?: number; time?: string; periods?: number; day?: number }
  >;
}

export interface ScheduledAlert {
  type: string;
  due_local: string;
  dedupe_key: string;
}

/** Which alerts are due in the next 30 days: dates, types and keys, nothing else. */
export async function alertsSchedule(inputs: AlertInputs): Promise<{ alerts: ScheduledAlert[] }> {
  return engine.call<{ alerts: ScheduledAlert[] }>("alerts.schedule", { inputs });
}

// insights (fast-follow 8): arithmetic over the device's own history; thresholds from config.

export interface SafeToSpend {
  safe_cents: number;
  per_day_cents: number;
  until: string;
  days: number;
  lowest_cents: number;
  lowest_date: string;
}

export async function safeToSpend(
  days: Array<{ date: string; balance_cents: number }>,
  bufferCents: number,
  asOf: string,
  until: string,
): Promise<SafeToSpend> {
  return engine.call<SafeToSpend>("insights.safe_to_spend", {
    days,
    buffer_cents: bufferCents,
    as_of: asOf,
    until,
  });
}

export interface UsualFlag {
  category_id: string;
  current_cents: number;
  usual_cents: number;
  increase_cents: number;
}

export async function vsUsual(
  asOf: string,
  entries: RuleEntry[],
  thresholds: Record<string, number>,
  months: number,
): Promise<{ months_used: number; flagged: UsualFlag[] }> {
  return engine.call("insights.vs_usual", { as_of: asOf, entries, thresholds, months });
}

export interface LumpyBill {
  payee: string;
  interval: string;
  due_date: string;
  amount_cents: number;
  months_to_save: number;
  per_month_cents: number;
}

export interface LumpyBills {
  bills: LumpyBill[];
  months: Array<{ month: string; total_cents: number; big: boolean }>;
}

export async function lumpyBills(
  asOf: string,
  series: Array<{
    payee: string;
    kind: "bill" | "income";
    expected_cents: number;
    interval: string;
    next_date: string;
  }>,
  thresholds: Record<string, number>,
  months: number,
): Promise<LumpyBills> {
  return engine.call<LumpyBills>("insights.lumpy_bills", {
    as_of: asOf,
    series,
    thresholds,
    months,
  });
}

export interface SeasonalFlag {
  month: string;
  last_year_month: string;
  last_year_cents: number;
  usual_cents: number;
  increase_cents: number;
}

export async function seasonalSpikes(
  asOf: string,
  entries: RuleEntry[],
  thresholds: Record<string, number>,
): Promise<{ months_of_history: number; flagged: SeasonalFlag[] }> {
  return engine.call("insights.seasonal", { as_of: asOf, entries, thresholds });
}

export interface ConsolidationOffer {
  apr_bps: number;
  fee_bps: number;
  promo_months: number;
  promo_apr_bps: number;
}

export interface Consolidation {
  today: { stalled: boolean; months: number | null; interest_cents: number | null };
  consolidated: {
    stalled: boolean;
    months: number | null;
    interest_cents: number | null;
    fee_cents: number;
    cost_cents: number | null;
    balance_after_promo_cents: number | null;
  };
  saves_cents: number | null;
}

export async function consolidation(
  debts: DebtInput[],
  offer: ConsolidationOffer,
  paymentCents: number,
  asOf: string,
): Promise<Consolidation> {
  return engine.call<Consolidation>("bills.consolidation", {
    debts,
    offer,
    payment_cents: paymentCents,
    as_of: asOf,
  });
}

/** Chunk 3.5: a card's balance ÷ limit (statement balance, else current), in bps. */
export interface Utilization {
  utilization_bps: number | null;
  balance_cents: number | null;
}

export async function cardUtilization(
  statementBalanceCents: number | null,
  currentBalanceCents: number | null,
  limitCents: number | null,
): Promise<Utilization> {
  return engine.call<Utilization>("credit.utilization_bps", {
    statement_balance_cents: statementBalanceCents,
    current_balance_cents: currentBalanceCents,
    limit_cents: limitCents,
  });
}

/** Chunk 3.5: what is left of the statement and how it splits across paydays before the due date. */
export interface PayInFull {
  status: "plan" | "paid" | "no_balance" | "no_due_date" | "past_due" | "no_payday";
  remaining_cents: number;
  paid_cents: number;
  due_date: string | null;
  days_left: number | null;
  payments: Array<{ date: string; amount_cents: number }>;
}

export async function payInFull(input: {
  asOf: string;
  statementBalanceCents: number;
  statementDate: string | null;
  lastPaymentCents: number | null;
  lastPaymentDate: string | null;
  dueDate: string | null;
  paydays: string[];
}): Promise<PayInFull> {
  return engine.call<PayInFull>("credit.pay_in_full", {
    as_of: input.asOf,
    statement_balance_cents: input.statementBalanceCents,
    statement_date: input.statementDate,
    last_payment_cents: input.lastPaymentCents,
    last_payment_date: input.lastPaymentDate,
    due_date: input.dueDate,
    paydays: input.paydays,
  });
}
