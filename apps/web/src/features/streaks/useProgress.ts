import { compareText } from "@stackd/rules/text";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { coverageStart, covers } from "../../data/coverage.ts";
import { useDb } from "../../data/DbProvider.tsx";
import {
  counted,
  type Entry,
  type Goal,
  type GoalEvent,
  ignoreClosed,
  type PaySettings,
  type StackdDb,
} from "../../data/db.ts";
import {
  addMonths,
  budgetSummary,
  emergencySummary,
  type MilestonesResult,
  milestonesOf,
  monthBounds,
  monthTotals,
  type OnTimeRun,
  type PathResult,
  streakOnTime,
  streakSorted,
  streakUnderPlan,
  streakWeekly,
  type WeeklyStreak,
  yourPath,
} from "../../engine/bridge.ts";
import { emitMoment } from "../../moments/bus.ts";
import { useCreditCards } from "../credit/useCreditCards.ts";
import { useLookups } from "../entries/useEntries.ts";
import { useForecast } from "../forecast/useForecast.ts";
import { newMoneyIn } from "../goals/useGoals.ts";
import { isEmergencyJar } from "../home/useHome.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";
import { useNetWorth } from "../networth/useNetWorth.ts";
import { needsSorting } from "../review/review.ts";
import { MILESTONE_THRESHOLDS, PATH_THRESHOLDS, REST_QUOTA, WEEKS_SHOWN } from "./config.ts";
import { milestoneName, stepName } from "./copy.ts";
import {
  FRESH_SEEN_KEY,
  MILESTONES_REACHED_KEY,
  markCelebrated,
  PATH_LAYOUT_KEY,
  PATH_REACHED_KEY,
  PAUSES_KEY,
  type PathLayout,
  RESTS_KEY,
  readDates,
  readLayout,
  readPauses,
  readRests,
  stampReached,
} from "./streakSettings.ts";

export interface ProgressView {
  ready: boolean;
  /** null until there is a jar; the others likewise until they have something to read. */
  setAside: WeeklyStreak | null;
  underPlan: WeeklyStreak | null;
  sorted: WeeklyStreak | null;
  onTime: OnTimeRun | null;
  path: PathResult | null;
  milestones: MilestonesResult | null;
  layout: PathLayout;
  paused: boolean;
  /** Per streak, the missed week the person already answered with Start again. */
  freshSeen: Record<string, string>;
  /** New money into jars dated this week (Home's day dots). */
  depositDays: string[];
  /** Entries waiting for a category (the Sorted card's line). */
  toSort: number;
}

const EMPTY: ProgressView = {
  ready: false,
  setAside: null,
  underPlan: null,
  sorted: null,
  onTime: null,
  path: null,
  milestones: null,
  layout: { order: [], skipped: [], names: {} },
  paused: false,
  freshSeen: {},
  depositDays: [],
  toSort: 0,
};

const EXPENSE_BUCKETS = new Set(["need", "want"]);

function earliest(dates: string[]): string | null {
  return dates.reduce<string | null>(
    (min, d) => (min === null || compareText(d, min) < 0 ? d : min),
    null,
  );
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return compareText(a, b) >= 0 ? a : b;
}

function sumOf(values: number[]): number {
  return values.reduce((n, v) => n + v, 0);
}

/**
 * Streaks, Your path and milestones (owner decision, November 19, 2026; invariant 94), from this
 * device's own data through the engine. Reading it also keeps what was reached: a path step or
 * milestone met for the first time is stamped with today (the first reading ever stamps quietly,
 * so what was already true never floods the screen), and the moments show once.
 */
export function useProgress(asOf: string): ProgressView {
  const { db } = useDb();
  const lookups = useLookups();
  const forecast = useForecast(asOf);
  const cards = useCreditCards(asOf);
  const worth = useNetWorth(asOf);
  const raw = useLiveQuery(async () => {
    const [goals, events, entries, budgets, lines, anchors, debts, accounts, fund, settings] =
      await Promise.all([
        db.goals.toArray(),
        db.goal_events.filter((e) => e.type === "deposit" || e.type === "withdrawal").toArray(),
        db.entries.toArray(),
        db.budgets.toArray(),
        db.budget_lines.toArray(),
        db.balance_anchors.count(),
        db.debts.count(),
        db.accounts.toArray(),
        db.emergency_fund.get("me"),
        db.settings
          .where("key")
          .anyOf([
            "pay",
            "forecast.buffer_cents",
            RESTS_KEY,
            PAUSES_KEY,
            FRESH_SEEN_KEY,
            PATH_LAYOUT_KEY,
            PATH_REACHED_KEY,
            MILESTONES_REACHED_KEY,
          ])
          .toArray(),
      ]);
    const setting = new Map(settings.map((s) => [s.key, s.value]));
    return {
      goals,
      events: events.sort((a, b) => compareText(a.date, b.date)),
      entries,
      budgets,
      lines,
      anchors,
      debtsListed: debts > 0 || accounts.some((a) => a.type === "credit_card"),
      fund: fund ?? null,
      coverage: await coverageStart(db),
      setting,
    };
  }, [db]);
  const [view, setView] = useState<ProgressView>(EMPTY);

  const cardsReady = cards !== undefined;
  const worthSummary = worth.loading ? undefined : worth.summary;

  useEffect(() => {
    if (!raw || !lookups || forecast.loading || !cardsReady || worthSummary === undefined) return;
    let alive = true;
    void (async () => {
      const { goals, events, entries, setting, coverage } = raw;
      const rests = readRests(setting.get(RESTS_KEY));
      const pauses = readPauses(setting.get(PAUSES_KEY));
      const layout = readLayout(setting.get(PATH_LAYOUT_KEY));
      const weekly = (
        since: string | null,
        met: string[],
        key: keyof typeof rests,
        skips: string[],
      ) =>
        streakWeekly({
          asOf,
          since,
          met,
          restQuota: REST_QUOTA,
          shown: WEEKS_SHOWN,
          rests: rests[key],
          pauses,
          skips,
        });

      // Set aside: new money into any jar (Move money sets nothing new aside).
      const jars = goals.filter((g) => g.kind === "save");
      const asideInputs = setAsideInputs(goals, events);
      const setAside = asideInputs
        ? await weekly(asideInputs.since, asideInputs.met, "set_aside", [])
        : null;

      // Under plan: needs + wants against each month's plan, from the first budget month that
      // the data covers.
      const bucketOf = (id: string | null) =>
        id ? (lookups.categories.get(id)?.bucket ?? null) : null;
      const plans: Array<{ month: string; planned_cents: number; needs: number }> = [];
      for (const b of raw.budgets) {
        const s = await budgetSummary(
          `${b.month}-01`,
          b.method,
          b.take_home_cents,
          raw.lines
            .filter((l) => l.budget_id === b.id)
            .map((l) => ({
              category_id: l.category_id,
              bucket: bucketOf(l.category_id),
              planned_cents: l.planned_cents,
            })),
          [],
          b.method === "50_30_20" ? (b.split_bps ?? null) : null,
        );
        const planned = (bucket: string) =>
          s.buckets.find((x) => x.bucket === bucket)?.planned_cents ?? 0;
        plans.push({
          month: b.month,
          planned_cents: planned("need") + planned("want"),
          needs: planned("need"),
        });
      }
      const spending = counted(entries).filter(
        (e) => !e.is_transfer && EXPENSE_BUCKETS.has(bucketOf(e.category_id) ?? ""),
      );
      let underPlan: WeeklyStreak | null = null;
      if (plans.length) {
        const firstMonth = earliest(plans.map((p) => `${p.month}-01`));
        const since = latest(firstMonth, coverage);
        const marks = await streakUnderPlan(
          asOf,
          since,
          plans.map((p) => ({ month: p.month, planned_cents: p.planned_cents })),
          spending.map((e) => ({
            date: e.date,
            direction: e.direction,
            amount_cents: e.amount_cents,
          })),
        );
        if (since) underPlan = await weekly(since, marks.met, "under_plan", marks.skips);
      }

      // Sorted: every counted entry of a whole week has its category.
      let sorted: WeeklyStreak | null = null;
      const toSort = entries.filter(needsSorting).length;
      if (entries.length && coverage) {
        const marks = await streakSorted(
          asOf,
          coverage,
          entries.map((e: Entry) => ({ date: e.date, sorted: !needsSorting(e) })),
        );
        sorted = await weekly(coverage, marks.met, "sorted", marks.skips);
      }

      // On time: card due dates across every card.
      const withHabits = (cards ?? []).filter((c) => c.habits !== null);
      const dues = withHabits.flatMap((c) => c.habits?.dues ?? []);
      const onTimeRun = await streakOnTime(dues, WEEKS_SHOWN);
      const onTime = onTimeRun.checked > 0 ? onTimeRun : null;

      // Your path's facts.
      const pay = setting.get("pay") as PaySettings | undefined;
      const buffer = setting.get("forecast.buffer_cents");
      const emergency = jars.find((g) => g.status !== "archived" && isEmergencyJar(g)) ?? null;
      const savedIn = (goalId: string) =>
        sumOf(
          events
            .filter((e) => e.goal_id === goalId)
            .map((e) => (e.type === "deposit" ? (e.amount_cents ?? 0) : -(e.amount_cents ?? 0))),
        );
      const emergencySaved = emergency ? savedIn(emergency.id) : 0;
      const month = asOf.slice(0, 7);
      const essentials =
        raw.fund?.essentials_cents ?? plans.find((p) => p.month === month)?.needs ?? 0;
      const runway =
        essentials > 0
          ? (
              await emergencySummary(
                emergencySaved,
                essentials,
                raw.fund?.target_months ?? 3,
                raw.fund?.monthly_plan_cents ?? 0,
              )
            ).runway_tenths
          : null;
      const fullMonths = withHabits.map((c) => c.habits?.paid_in_full_streak ?? null);
      const paidInFull =
        fullMonths.length && fullMonths.every((m) => m !== null)
          ? Math.min(...(fullMonths as number[]))
          : null;
      const groups = worthSummary?.groups ?? [];
      const debtsCents = sumOf(
        groups.filter((g) => g.kind === "debt" && g.group !== "mortgage").map((g) => g.total_cents),
      );
      const laterCents = sumOf(
        groups
          .filter(
            (g) => g.kind === "asset" && (g.group === "investments" || g.group === "retirement"),
          )
          .map((g) => g.total_cents),
      );
      const path = await yourPath({
        asOf,
        facts: {
          pay_set: Boolean(pay?.next_payday && pay.amount_cents > 0),
          budget_set: raw.budgets.length > 0,
          balance_set: raw.anchors > 0,
          cushion_cents: typeof buffer === "number" && Number.isInteger(buffer) ? buffer : null,
          balance_cents: forecast.start?.balance_cents ?? null,
          emergency_saved_cents: emergencySaved,
          has_cards: withHabits.length > 0,
          paid_in_full_months: paidInFull,
          debts_cents: debtsCents,
          runway_tenths: runway,
          later_cents: laterCents,
        },
        thresholds: PATH_THRESHOLDS,
        reached: readDates(setting.get(PATH_REACHED_KEY)),
        order: layout.order,
        skipped: layout.skipped,
      });

      // Milestones' facts: last month's Kept counts only when the data covers all of it.
      const prevStart = await addMonths(`${month}-01`, -1);
      let lastMonthKept = 0;
      if (covers(coverage, prevStart)) {
        const bounds = await monthBounds(prevStart);
        const prev = counted(entries).filter(
          (e) => compareText(e.date, bounds.start) >= 0 && compareText(e.date, bounds.end) <= 0,
        );
        lastMonthKept = (
          await monthTotals(
            bounds.start,
            prev.map((e) => toRuleEntry(e, lookups.categories)),
          )
        ).net_cents;
      }
      const milestones = await milestonesOf({
        asOf,
        facts: {
          jars: jars.length,
          emergency_saved_cents: emergencySaved,
          best_set_aside: setAside?.best ?? 0,
          last_month_kept_cents: Math.max(0, lastMonthKept),
          best_on_time: onTime?.best ?? 0,
          entries: entries.length,
          to_sort: toSort,
          challenges_reached: goals.filter((g) => g.group_id && g.status === "reached").length,
          has_cards: withHabits.length > 0,
          paid_in_full_months: paidInFull,
          debts_listed: raw.debtsListed,
          debts_cents: debtsCents,
          runway_tenths: runway,
          jars_saved_cents: sumOf(
            jars.filter((g) => g.status !== "archived").map((g) => savedIn(g.id)),
          ),
        },
        thresholds: MILESTONE_THRESHOLDS,
        reached: readDates(setting.get(MILESTONES_REACHED_KEY)),
      });

      const weekStart = setAside?.weeks.at(-1)?.start ?? asOf;
      if (!alive) return;
      setView({
        ready: true,
        setAside,
        underPlan,
        sorted,
        onTime,
        path,
        milestones,
        layout,
        paused: pauses.some((p) => p.end === null),
        freshSeen: readDates(setting.get(FRESH_SEEN_KEY)),
        depositDays: (asideInputs?.met ?? []).filter(
          (d) => compareText(d, weekStart) >= 0 && compareText(d, asOf) <= 0,
        ),
        toSort,
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [raw, lookups, forecast.loading, forecast.start, cards, cardsReady, worthSummary, asOf]);

  // Keep what was reached, and celebrate it once.
  useEffect(() => {
    if (!view.ready) return;
    void (async () => {
      const steps = view.path?.newly_reached ?? [];
      if (steps.length || view.path) {
        const { added, first } = await stampReached(db, PATH_REACHED_KEY, steps, asOf);
        if (!first) {
          for (const id of added) {
            emitMoment("path_step_reached", { step: stepName(id, view.layout) }, `path:${id}`);
          }
        }
      }
      const badges = view.milestones?.newly_reached ?? [];
      if (badges.length || view.milestones) {
        const { added, first } = await stampReached(db, MILESTONES_REACHED_KEY, badges, asOf);
        const id = added[0];
        if (!first && id)
          emitMoment("badge_reached", { milestone: milestoneName(id) }, `badge:${id}`);
      }
      await celebrateWeek(db, view.setAside);
    })().catch(ignoreClosed);
  }, [db, view, asOf]);

  return view;
}

/** The Set aside streak's moment: once a week, on the deposit that keeps it, from 2 weeks on. */
export async function celebrateWeek(db: StackdDb, s: WeeklyStreak | null): Promise<void> {
  const week = s?.weeks.at(-1)?.start;
  if (!s || !week || s.this_week !== "kept" || s.current < 2) return;
  if (await markCelebrated(db, week)) {
    emitMoment("streak_kept", { weeks: String(s.current) }, `streak:${week}`);
  }
}

/** Set aside's inputs: every jar's start and the dates of new money into jars. */
export function setAsideInputs(
  goals: Goal[],
  events: GoalEvent[],
): { since: string | null; met: string[] } | null {
  const jars = goals.filter((g) => g.kind === "save");
  if (!jars.length) return null;
  const met = newMoneyIn(events).map((e) => e.date);
  return { since: earliest([...jars.map((g) => g.start_date), ...met]), met };
}

/**
 * Home's light reading: the Set aside streak only, from jars and settings, so Home never runs
 * the forecast, cards and net worth twice. It celebrates the week like the full reading does.
 */
export function useSetAsideStreak(asOf: string): {
  ready: boolean;
  streak: WeeklyStreak | null;
  paused: boolean;
  freshSeen: Record<string, string>;
  depositDays: string[];
} {
  const { db } = useDb();
  const raw = useLiveQuery(async () => {
    const [goals, events, settings] = await Promise.all([
      db.goals.toArray(),
      db.goal_events.filter((e) => e.type === "deposit" || e.type === "withdrawal").toArray(),
      db.settings.where("key").anyOf([RESTS_KEY, PAUSES_KEY, FRESH_SEEN_KEY]).toArray(),
    ]);
    return {
      goals,
      events: events.sort((a, b) => compareText(a.date, b.date)),
      setting: new Map(settings.map((x) => [x.key, x.value])),
    };
  }, [db]);
  const [state, setState] = useState<{
    ready: boolean;
    streak: WeeklyStreak | null;
    paused: boolean;
    freshSeen: Record<string, string>;
    depositDays: string[];
  }>({ ready: false, streak: null, paused: false, freshSeen: {}, depositDays: [] });
  useEffect(() => {
    if (!raw) return;
    let alive = true;
    void (async () => {
      const inputs = setAsideInputs(raw.goals, raw.events);
      const pauses = readPauses(raw.setting.get(PAUSES_KEY));
      const streak = inputs
        ? await streakWeekly({
            asOf,
            since: inputs.since,
            met: inputs.met,
            restQuota: REST_QUOTA,
            shown: WEEKS_SHOWN,
            rests: readRests(raw.setting.get(RESTS_KEY)).set_aside,
            pauses,
          })
        : null;
      const weekStart = streak?.weeks.at(-1)?.start ?? asOf;
      if (!alive) return;
      setState({
        ready: true,
        streak,
        paused: pauses.some((p) => p.end === null),
        freshSeen: readDates(raw.setting.get(FRESH_SEEN_KEY)),
        depositDays: (inputs?.met ?? []).filter(
          (d) => compareText(d, weekStart) >= 0 && compareText(d, asOf) <= 0,
        ),
      });
      await celebrateWeek(db, streak);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, raw, asOf]);
  return state;
}
