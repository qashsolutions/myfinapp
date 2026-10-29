import insightsConfig from "@stackd/rules/insights";
import { useLiveQuery } from "dexie-react-hooks";
import type { CardSpec } from "../../app/layout/cardLayout.ts";
import { useDb } from "../../data/DbProvider.tsx";
import type { Bucket, StackdDb } from "../../data/db.ts";
import type { BudgetSummary, OneChangeCandidate, OneChangePick } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { paceLines } from "../budget/pace.ts";

/**
 * Your month, the once-a-month review (October 28, 2026; docs/spec.md "Your month"). The values
 * live in config/insights.yaml `month_review` (signed off by the owner, October 29, 2026).
 */
const CONFIG = (
  insightsConfig as {
    month_review: { show_days: number; debt_add_cents: number; one_change_order: string[] };
  }
).month_review;

/** Home shows the card during the first days of a month. */
export const SHOW_DAYS: number = CONFIG.show_days;
/** With nothing over plan, the debt candidate puts this much more a month on the debts. */
export const DEBT_ADD_CENTS: number = CONFIG.debt_add_cents;
/** Ties between candidates go by this order (insights.one_change). */
export const ONE_CHANGE_ORDER: string[] = CONFIG.one_change_order;

export const MONTH_REVIEW_PATH = "/month-review";

/** `settings` key set by Done: the Home card stays hidden for that month. */
export function doneKey(month: string): string {
  return `month_review.done.${month}`;
}

/**
 * The person's own Home card choices (October 29, 2026; the Adjust sheet): whether the card
 * shows at all, and for how many days of a month (1 to 28; the config's 7 until they pick).
 */
export const HOME_CARD_KEY = "month_review.home_card";
export const SHOW_DAYS_KEY = "month_review.show_days";
export const SHOW_DAYS_MAX = 28;
export const SHOW_DAYS_CHOICES = [3, 7, 14];

export function readShowDays(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= SHOW_DAYS_MAX
    ? raw
    : SHOW_DAYS;
}

export interface MonthReviewPrefs {
  homeCard: boolean;
  showDays: number;
}

/** The Home card choices, live; undefined while reading. */
export function useMonthReviewPrefs(): MonthReviewPrefs | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [card, days] = await Promise.all([
      db.settings.get(HOME_CARD_KEY),
      db.settings.get(SHOW_DAYS_KEY),
    ]);
    return { homeCard: card?.value !== false, showDays: readShowDays(days?.value) };
  }, [db]);
}

export async function saveReviewPref(db: StackdDb, key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value, updated_at: new Date().toISOString() });
}

/** Whether Home shows the card on `day` of the month with these choices. */
export function homeCardDue(prefs: MonthReviewPrefs, day: number): boolean {
  return prefs.homeCard && day <= prefs.showDays;
}

/** The sections below the summary, in the person's order (Customize Your month). */
export type ReviewSection = "budget" | "fixed" | "jars" | "debt" | "subs" | "change";
export const REVIEW_SECTIONS: readonly CardSpec<ReviewSection>[] = [
  ["budget", "Budget", "Spending against your plan"],
  ["fixed", "Fixed vs flexible", "Bills against everything else"],
  ["jars", "Jars", "New money into your jars"],
  ["debt", "Debt", "Debt-free date and cards"],
  ["subs", "Subscriptions", "What there is to check"],
  ["change", "One change", "One idea from your own numbers"],
];

export async function markReviewDone(db: StackdDb, month: string): Promise<void> {
  await db.settings.put({ key: doneKey(month), value: true, updated_at: new Date().toISOString() });
}

/** The day of the month of an ISO date (layout only: the date is already the person's local day). */
export function dayOfMonth(iso: string): number {
  return Number.parseInt(iso.slice(8, 10), 10);
}

/** A `?month=YYYY-MM` value, or null when it is not one. */
export function monthParam(raw: string | null): string | null {
  return raw && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
}

/** The most-over line of a month's budget: what "over_plan" is built from. */
export interface OverPlan {
  /** The expense line most over (zero-based), else null. */
  category_id: string | null;
  /** The needs or wants bucket most over (50/30/20), else null. */
  bucket: Bucket | null;
  over_cents: number;
  /** The category What if's "Spend less" opens on: the line itself, or the bucket's largest. */
  whatif_category: string | null;
}

/**
 * Zero-based: the expense lines over their plan, most over first (ties keep the summary's order).
 * The lines are Budget's own (`paceLines`, which the budget alert reads too): something planned,
 * never the save bucket. A line with nothing planned is waiting for its job, not over.
 */
export function linesOver(
  summary: BudgetSummary,
): Array<{ category_id: string; over_cents: number }> {
  return paceLines({ ...summary, method: "zero_based" })
    .filter((c) => c.spent_cents > c.planned_cents)
    .map((c) => ({
      category_id: c.category_id,
      over_cents: c.spent_cents - c.planned_cents,
    }))
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.over_cents - a.over_cents || a.i - b.i)
    .map(({ category_id, over_cents }) => ({ category_id, over_cents }));
}

/** 50/30/20: needs and wants buckets over plan, most over first (ties: needs first). */
export function bucketsOver(summary: BudgetSummary): Array<{ bucket: Bucket; over_cents: number }> {
  const rank: Record<string, number> = { need: 0, want: 1 };
  return summary.buckets
    .filter(
      (b) =>
        (b.bucket === "need" || b.bucket === "want") && b.planned_cents > 0 && b.left_cents < 0,
    )
    .map((b) => ({ bucket: b.bucket, over_cents: -b.left_cents }))
    .sort((a, b) => b.over_cents - a.over_cents || (rank[a.bucket] ?? 2) - (rank[b.bucket] ?? 2));
}

export function mostOver(summary: BudgetSummary | null): OverPlan | null {
  if (!summary) return null;
  if (summary.method === "zero_based") {
    const top = linesOver(summary)[0];
    return top
      ? {
          category_id: top.category_id,
          bucket: null,
          over_cents: top.over_cents,
          whatif_category: top.category_id,
        }
      : null;
  }
  const top = bucketsOver(summary)[0];
  if (!top) return null;
  const biggest = summary.categories
    .filter((c) => c.bucket === top.bucket && c.spent_cents > 0)
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.spent_cents - a.spent_cents || a.i - b.i)[0];
  return {
    category_id: null,
    bucket: top.bucket,
    over_cents: top.over_cents,
    whatif_category: biggest?.category_id ?? null,
  };
}

/** What the device hands insights.one_change, with what each card needs to say and link. */
export interface ChangeOption {
  candidate: OneChangeCandidate;
  /** over_plan: the line or bucket; debt_interest: the amount a month put on the debts. */
  over?: OverPlan;
  addCents?: number;
  /** subscription_check: how many are asked about, and their names (same order). */
  count?: number;
  names?: string[];
  /** debt_interest: the payoff time today and with the amount added, for the picture. */
  sooner?: DebtSooner;
}

export interface DebtSooner {
  months_before: number;
  months_after: number | null;
  month_before: string | null;
  month_after: string | null;
}

/** The candidates in a fixed order (the rule breaks ties by config, then by this order). */
export function buildOptions(input: {
  over: OverPlan | null;
  askedYearly: number[];
  askedNames?: string[];
  debt: {
    interest_saved_cents: number | null;
    months: number | null;
    add_cents: number;
    months_after?: number | null;
    month_before?: string | null;
    month_after?: string | null;
  } | null;
}): ChangeOption[] {
  const out: ChangeOption[] = [];
  if (input.over && input.over.over_cents > 0)
    out.push({
      candidate: { kind: "over_plan", amounts_cents: [input.over.over_cents], months: 1 },
      over: input.over,
    });
  if (input.askedYearly.length > 0)
    out.push({
      candidate: { kind: "subscription_check", amounts_cents: input.askedYearly, months: 12 },
      count: input.askedYearly.length,
      names: input.askedNames,
    });
  const d = input.debt;
  if (d && d.interest_saved_cents !== null && d.months !== null && d.months >= 1)
    out.push({
      candidate: {
        kind: "debt_interest",
        amounts_cents: [d.interest_saved_cents],
        months: d.months,
      },
      addCents: d.add_cents,
      sooner: {
        months_before: d.months,
        months_after: d.months_after ?? null,
        month_before: d.month_before ?? null,
        month_after: d.month_after ?? null,
      },
    });
  return out;
}

/** The address "Try it in What if" opens, prefilled with the lever, category and amount. */
export function whatIfLink(option: ChangeOption): string | null {
  if (option.candidate.kind === "over_plan" && option.over) {
    const q = new URLSearchParams({ lever: "spend", amount: String(option.over.over_cents) });
    if (option.over.whatif_category) q.set("category", option.over.whatif_category);
    return `/what-if?${q.toString()}`;
  }
  if (option.candidate.kind === "debt_interest" && option.addCents)
    return `/what-if?${new URLSearchParams({ lever: "debts", amount: String(option.addCents) }).toString()}`;
  return null;
}

export interface PickedChange {
  option: ChangeOption;
  pick: OneChangePick;
}

/** Months between two YYYY-MM keys are compared as text (same width), never as dates. */
export function monthBefore(a: string, b: string): boolean {
  return compareText(a, b) < 0;
}
