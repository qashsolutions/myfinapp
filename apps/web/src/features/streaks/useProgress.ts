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
import {
  HISTORY_MONTHS,
  MILESTONE_THRESHOLDS,
  PATH_THRESHOLDS,
  REST_QUOTA,
  WEEKS_SHOWN,
} from "./config.ts";
import { milestoneName, stepName } from "./copy.ts";
import {
  BEST_KEY,
  type BestRecord,
  FRESH_SEEN_KEY,
  MILESTONES_REACHED_KEY,
  markCelebrated,
  PATH_LAYOUT_KEY,
  PATH_REACHED_KEY,
  PAUSES_KEY,
  type PathLayout,
  RESTS_KEY,
  readBest,
  readDates,
  readLayout,
  readPauses,
  readReachedMilestones,
  readRests,
  saveBest,
  stampReached,
} from "./streakSettings.ts";

/** The four streaks and what the path and milestones need from the same reading. */
export interface StreaksView {
  ready: boolean;
  /** null until there is a jar; the others likewise until they have something to read. */
  setAside: WeeklyStreak | null;
  underPlan: WeeklyStreak | null;
  sorted: WeeklyStreak | null;
  onTime: OnTimeRun | null;
  paused: boolean;
  /** Per streak, the missed week the person already answered with Start again. */
  freshSeen: Record<string, string>;
  /** New money into jars dated this week (Home's day dots). */
  depositDays: string[];
  /** Entries waiting for a category (the Sorted card's line). */
  toSort: number;
  facts: {
    jars: number;
    jarsSavedCents: number;
    emergencySavedCents: number;
    challengesReached: number;
    entries: number;
    lastMonthKeptCents: number;
    currentNeedsCents: number;
    hasCards: boolean;
    paidInFullMonths: number | null;
  };
}

export interface ProgressView extends StreaksView {
  path: PathResult | null;
  milestones: MilestonesResult | null;
  layout: PathLayout;
}

const EMPTY_FACTS: StreaksView["facts"] = {
  jars: 0,
  jarsSavedCents: 0,
  emergencySavedCents: 0,
  challengesReached: 0,
  entries: 0,
  lastMonthKeptCents: 0,
  currentNeedsCents: 0,
  hasCards: false,
  paidInFullMonths: null,
};

const EMPTY_STREAKS: StreaksView = {
  ready: false,
  setAside: null,
  underPlan: null,
  sorted: null,
  onTime: null,
  paused: false,
  freshSeen: {},
  depositDays: [],
  toSort: 0,
  facts: EMPTY_FACTS,
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

/** The Set aside streak's moment: once a week, on the deposit that keeps it, from 2 weeks on. */
export async function celebrateWeek(db: StackdDb, s: WeeklyStreak | null): Promise<void> {
  const week = s?.weeks.at(-1)?.start;
  if (!s || !week || s.this_week !== "kept" || s.current < 2) return;
  if (await markCelebrated(db, week)) {
    emitMoment("streak_kept", { weeks: String(s.current) }, `streak:${week}`);
  }
}

/**
 * The four streaks (owner decision, November 19, 2026; invariant 94) from this device's own
 * data through the engine: jars, entries, budgets and the cards' due dates. Light enough for
 * Home: no forecast and no net worth. Celebrates the Set aside week once.
 */
export function useStreaks(asOf: string): StreaksView {
  const { db } = useDb();
  const lookups = useLookups();
  const cards = useCreditCards(asOf);
  const raw = useLiveQuery(async () => {
    const [goals, events, entries, budgets, lines, settings] = await Promise.all([
      db.goals.toArray(),
      db.goal_events.filter((e) => e.type === "deposit" || e.type === "withdrawal").toArray(),
      db.entries.toArray(),
      db.budgets.toArray(),
      db.budget_lines.toArray(),
      db.settings.where("key").anyOf([RESTS_KEY, PAUSES_KEY, FRESH_SEEN_KEY, BEST_KEY]).toArray(),
    ]);
    return {
      goals,
      events: events.sort((a, b) => compareText(a.date, b.date)),
      entries,
      budgets,
      lines,
      coverage: await coverageStart(db),
      setting: new Map(settings.map((s) => [s.key, s.value])),
    };
  }, [db]);
  const [view, setView] = useState<StreaksView>(EMPTY_STREAKS);

  useEffect(() => {
    if (!raw || !lookups || cards === undefined) return;
    let alive = true;
    void (async () => {
      const { goals, events, entries, setting, coverage } = raw;
      const rests = readRests(setting.get(RESTS_KEY));
      const pauses = readPauses(setting.get(PAUSES_KEY));
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
          historyMonths: HISTORY_MONTHS,
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
      const withHabits = cards.filter((c) => c.habits !== null);
      const onTimeRun = await streakOnTime(
        withHabits.flatMap((c) => c.streakDues),
        WEEKS_SHOWN,
      );
      const onTime = onTimeRun.checked > 0 ? onTimeRun : null;

      // The best ever is kept (owner decision, November 20, 2026): a run longer than the 4-year
      // window, or one on data since removed, still shows. It only ever goes up.
      const saved = readBest(setting.get(BEST_KEY));
      const keep = <T extends { best: number }>(s: T | null, id: keyof BestRecord): T | null =>
        s ? { ...s, best: Math.max(s.best, saved[id] ?? 0) } : null;
      const higher: BestRecord = { ...saved };
      let raised = false;
      for (const [id, s] of [
        ["set_aside", setAside],
        ["under_plan", underPlan],
        ["sorted", sorted],
        ["on_time", onTime],
      ] as const) {
        if (s && s.best > (saved[id] ?? 0)) {
          higher[id] = s.best;
          raised = true;
        }
      }

      // What the path and milestones read from the same data.
      const savedIn = (goalId: string) =>
        sumOf(
          events
            .filter((e) => e.goal_id === goalId)
            .map((e) => (e.type === "deposit" ? (e.amount_cents ?? 0) : -(e.amount_cents ?? 0))),
        );
      const emergency = jars.find((g) => g.status !== "archived" && isEmergencyJar(g)) ?? null;
      const fullMonths = withHabits.map((c) => c.habits?.paid_in_full_streak ?? null);
      const month = asOf.slice(0, 7);
      // Last month's Kept counts only when the data covers all of it.
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

      const weekStart = setAside?.weeks.at(-1)?.start ?? asOf;
      if (!alive) return;
      setView({
        ready: true,
        setAside: keep(setAside, "set_aside"),
        underPlan: keep(underPlan, "under_plan"),
        sorted: keep(sorted, "sorted"),
        onTime: keep(onTime, "on_time"),
        paused: pauses.some((p) => p.end === null),
        freshSeen: readDates(setting.get(FRESH_SEEN_KEY)),
        depositDays: (asideInputs?.met ?? []).filter(
          (d) => compareText(d, weekStart) >= 0 && compareText(d, asOf) <= 0,
        ),
        toSort,
        facts: {
          jars: jars.length,
          jarsSavedCents: sumOf(
            jars.filter((g) => g.status !== "archived").map((g) => savedIn(g.id)),
          ),
          emergencySavedCents: emergency ? savedIn(emergency.id) : 0,
          challengesReached: goals.filter((g) => g.group_id && g.status === "reached").length,
          entries: entries.length,
          lastMonthKeptCents: Math.max(0, lastMonthKept),
          currentNeedsCents: plans.find((p) => p.month === month)?.needs ?? 0,
          hasCards: withHabits.length > 0,
          paidInFullMonths:
            fullMonths.length && fullMonths.every((m) => m !== null)
              ? Math.min(...(fullMonths as number[]))
              : null,
        },
      });
      if (raised) await saveBest(db, higher);
      await celebrateWeek(db, setAside);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, raw, lookups, cards, asOf]);

  return view;
}

/**
 * The streaks plus Your path and milestones. Reading it also keeps what was reached: a path
 * step or milestone met for the first time is stamped with today (the first reading ever stamps
 * quietly, so what was already true never floods the screen), and the moments show once.
 */
export function useProgress(asOf: string): ProgressView {
  const { db } = useDb();
  const streaks = useStreaks(asOf);
  const forecast = useForecast(asOf);
  const worth = useNetWorth(asOf);
  const raw = useLiveQuery(async () => {
    const [budgets, anchors, debts, accounts, fund, settings] = await Promise.all([
      db.budgets.count(),
      db.balance_anchors.count(),
      db.debts.count(),
      db.accounts.toArray(),
      db.emergency_fund.get("me"),
      db.settings
        .where("key")
        .anyOf([
          "pay",
          "forecast.buffer_cents",
          PATH_LAYOUT_KEY,
          PATH_REACHED_KEY,
          MILESTONES_REACHED_KEY,
        ])
        .toArray(),
    ]);
    return {
      budgets,
      anchors,
      debtsListed: debts > 0 || accounts.some((a) => a.type === "credit_card"),
      fund: fund ?? null,
      setting: new Map(settings.map((s) => [s.key, s.value])),
    };
  }, [db]);
  const [extra, setExtra] = useState<{
    path: PathResult;
    milestones: MilestonesResult;
    layout: PathLayout;
  } | null>(null);

  const worthSummary = worth.loading ? undefined : worth.summary;

  useEffect(() => {
    if (!raw || !streaks.ready || forecast.loading || worthSummary === undefined) return;
    let alive = true;
    void (async () => {
      const { setting } = raw;
      const f = streaks.facts;
      const layout = readLayout(setting.get(PATH_LAYOUT_KEY));
      const pay = setting.get("pay") as PaySettings | undefined;
      const buffer = setting.get("forecast.buffer_cents");
      const essentials = raw.fund?.essentials_cents ?? f.currentNeedsCents;
      const runway =
        essentials > 0
          ? (
              await emergencySummary(
                f.emergencySavedCents,
                essentials,
                raw.fund?.target_months ?? 3,
                raw.fund?.monthly_plan_cents ?? 0,
              )
            ).runway_tenths
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
          budget_set: raw.budgets > 0,
          balance_set: raw.anchors > 0,
          cushion_cents: typeof buffer === "number" && Number.isInteger(buffer) ? buffer : null,
          balance_cents: forecast.start?.balance_cents ?? null,
          emergency_saved_cents: f.emergencySavedCents,
          has_cards: f.hasCards,
          paid_in_full_months: f.paidInFullMonths,
          debts_cents: debtsCents,
          runway_tenths: runway,
          later_cents: laterCents,
        },
        thresholds: PATH_THRESHOLDS,
        reached: readDates(setting.get(PATH_REACHED_KEY)),
        order: layout.order,
        skipped: layout.skipped,
      });
      const milestones = await milestonesOf({
        asOf,
        facts: {
          jars: f.jars,
          emergency_saved_cents: f.emergencySavedCents,
          best_set_aside: streaks.setAside?.best ?? 0,
          last_month_kept_cents: f.lastMonthKeptCents,
          best_on_time: streaks.onTime?.best ?? 0,
          entries: f.entries,
          to_sort: streaks.toSort,
          challenges_reached: f.challengesReached,
          has_cards: f.hasCards,
          paid_in_full_months: f.paidInFullMonths,
          debts_listed: raw.debtsListed,
          debts_cents: debtsCents,
          runway_tenths: runway,
          jars_saved_cents: f.jarsSavedCents,
        },
        thresholds: MILESTONE_THRESHOLDS,
        reached: readReachedMilestones(setting.get(MILESTONES_REACHED_KEY)),
      });
      if (!alive) return;
      setExtra({ path, milestones, layout });

      // Keep what was reached, and celebrate it once.
      const stamped = await stampReached(db, PATH_REACHED_KEY, path.newly_reached, asOf);
      if (!stamped.first) {
        for (const id of stamped.added) {
          emitMoment("path_step_reached", { step: stepName(id, layout) }, `path:${id}`);
        }
      }
      const badges = await stampReached(db, MILESTONES_REACHED_KEY, milestones.newly_reached, asOf);
      const id = badges.added[0];
      if (!badges.first && id) {
        emitMoment("badge_reached", { milestone: milestoneName(id) }, `badge:${id}`);
      }
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, raw, streaks, forecast.loading, forecast.start, worthSummary, asOf]);

  return {
    ...streaks,
    // Streaks show as soon as they are counted; the path and milestones join when ready.
    ready: streaks.ready,
    path: extra?.path ?? null,
    milestones: extra?.milestones ?? null,
    layout: extra?.layout ?? { order: [], skipped: [], names: {} },
  };
}
