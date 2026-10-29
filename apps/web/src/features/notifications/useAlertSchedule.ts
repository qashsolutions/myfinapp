import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef } from "react";
import { localStamp, syncAlertSchedule } from "../../data/alertSchedule.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { todayIso } from "../../lib/format.ts";
import { ALERT_OFF_SETTING } from "../budget/pace.ts";
import { useBudget } from "../budget/useBudget.ts";
import { useForecast } from "../forecast/useForecast.ts";
import { useGoals } from "../goals/useGoals.ts";
import { useGroups } from "../groups/useGroups.ts";
import { useNotificationSettings } from "./useNotifications.ts";

/**
 * Keeps the server's copy of the alert schedule current: whenever the forecast, goals,
 * challenges or preferences change, the device recomputes which alerts are due and registers
 * dates, types and dedupe keys. Mounted once, inside the app shell.
 */
export function useAlertSchedule(): void {
  const { db } = useDb();
  const today = todayIso();
  const forecast = useForecast(today);
  // This month's budget as Budget reads it (never carried forward from here).
  const budget = useBudget(today, false).summary;
  const goals = useGoals();
  // Read for the schedule, not for a screen: background calls (never counted as activity).
  const groups = useGroups({ background: true });
  const settings = useNotificationSettings({ background: true });
  const milestones = useLiveQuery(
    async () =>
      (await db.goal_milestones.toArray())
        .filter((m) => m.reached_at !== null)
        .map((m) => ({ goal_id: m.goal_id, key: m.id })),
    [db],
  );
  // Chunk 3.5: a new card statement (due date, balance) changes the schedule too.
  const cards = useLiveQuery(() => db.card_details.toArray(), [db]);
  // A budget line turned off or back on ("Don't alert me for this one", October 29, 2026).
  const alertOff = useLiveQuery(
    async () => (await db.settings.get(ALERT_OFF_SETTING))?.value,
    [db],
  );
  const running = useRef(false);
  const projection = forecast.projection;
  const upcoming = forecast.upcoming;
  const prefs = settings.data?.prefs;
  const challenges = groups.groups;

  // biome-ignore lint/correctness/useExhaustiveDependencies: cards and alertOff are triggers; buildInputs reads the tables
  useEffect(() => {
    if (forecast.loading || !goals || !prefs || !challenges || running.current) return;
    running.current = true;
    void syncAlertSchedule(db, {
      nowLocal: localStamp(new Date()),
      asOf: today,
      upcoming,
      projection,
      challenges: challenges.map((g) => ({ group_id: g.id, end_date: g.end_date })),
      goals: goals.filter((g) => !g.paused_at),
      milestonesReached: milestones ?? [],
      budget,
      prefs,
    })
      .catch(() => null)
      .finally(() => {
        running.current = false;
      });
  }, [
    db,
    forecast.loading,
    upcoming,
    projection,
    goals,
    challenges,
    prefs,
    today,
    milestones,
    cards,
    alertOff,
    budget,
  ]);
}

export function AlertScheduleSync() {
  useAlertSchedule();
  return null;
}
