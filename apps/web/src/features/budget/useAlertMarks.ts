import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { useNotificationSettings } from "../notifications/useNotifications.ts";
import { ALERT_OFF_SETTING, closeLevelBps, readAlertOff } from "./pace.ts";

/**
 * What a budget line's `PaceBar` marks, read the way the Budget tab reads it (October 29, 2026):
 * the person's "Tell me at" level, else the config's, and whether a line's alert is on (the
 * alert is on and the line wasn't turned off). Your month uses it so its bars match Budget.
 */
export function useAlertMarks(): { levelBps: number; alerting: (lineId: string) => boolean } {
  const alerts = useNotificationSettings({ background: true });
  const prefs = alerts.data?.prefs?.budget_pace;
  const { db } = useDb();
  const off = useLiveQuery(
    async () => readAlertOff((await db.settings.get(ALERT_OFF_SETTING))?.value),
    [db],
  );
  const on = prefs?.enabled ?? false;
  const alerting = useMemo(() => {
    const skip = new Set(off ?? []);
    return (id: string) => on && !skip.has(id);
  }, [off, on]);
  return { levelBps: closeLevelBps(prefs?.threshold ?? null), alerting };
}
