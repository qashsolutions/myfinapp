import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { useNotificationSettings } from "../notifications/useNotifications.ts";
import { ALERT_OFF_SETTING, closeLevelBps, readAlertOff } from "./pace.ts";

export interface AlertMarks {
  /** The "Tell me at" level each bar marks: the person's own, else the config's. */
  levelBps: number;
  /** The person's own "Tell me at" in percent, or null when they never set one. */
  threshold: number | null;
  /** Whether the budget alert is on at all. */
  on: boolean;
  /** The lines the person turned the alert off for; undefined while reading. */
  off: string[] | undefined;
  /** Whether a line's alert is on (the alert is on and the line wasn't turned off). */
  alerting: (lineId: string) => boolean;
  /** The alert settings themselves, for Budget's Adjust sheet (read once, here). */
  settings: ReturnType<typeof useNotificationSettings>;
}

/**
 * The one reading of a budget line's alert marks (October 29, 2026; invariant 30): the Budget
 * tab and Your month both draw their `PaceBar`s from it, so the two never disagree.
 */
export function useAlertMarks(): AlertMarks {
  const alerts = useNotificationSettings({ background: true });
  const prefs = alerts.data?.prefs?.budget_pace;
  const { db } = useDb();
  const off = useLiveQuery(
    async () => readAlertOff((await db.settings.get(ALERT_OFF_SETTING))?.value),
    [db],
  );
  const on = prefs?.enabled ?? false;
  const threshold = prefs?.threshold ?? null;
  const alerting = useMemo(() => {
    const skip = new Set(off ?? []);
    return (id: string) => on && !skip.has(id);
  }, [off, on]);
  return { levelBps: closeLevelBps(threshold), threshold, on, off, alerting, settings: alerts };
}
