import { useCallback, useEffect, useState } from "react";
import {
  type ApiFailure,
  api,
  clientFor,
  failureOf,
  type NotificationSettingsOut,
  type NotificationSettingsPatch,
} from "../../data/api.ts";
import { pushSettingsTitle } from "../../moments/catalog.ts";

export const TYPE_COPY: Record<
  string,
  { title: string; sub: (p: NotificationSettingsOut["prefs"][string]) => string }
> = {
  upcoming_expense: {
    title: pushSettingsTitle("upcoming_expense"),
    sub: (p) =>
      `${p.lead_days ?? 3} ${p.lead_days === 1 ? "day" : "days"} before · bills and recurring`,
  },
  shortfall_risk: {
    title: pushSettingsTitle("shortfall_risk"),
    sub: (p) => withDelivery(p, "When the forecast dips below your buffer"),
  },
  challenge_checkin: {
    title: pushSettingsTitle("challenge_checkin"),
    sub: (p) => `Daily at ${clockText(p.time_of_day ?? "19:30")}`,
  },
  goal_behind_pace: {
    title: pushSettingsTitle("goal_behind_pace"),
    sub: (p) => `After ${p.threshold ?? 1} missed ${p.threshold === 2 ? "periods" : "period"}`,
  },
  milestone_reached: {
    title: pushSettingsTitle("milestone_reached"),
    sub: (p) => withDelivery(p, "When a jar hits a milestone"),
  },
  group_activity: {
    title: pushSettingsTitle("group_activity"),
    sub: (p) => withDelivery(p, "Joins and challenge ends"),
  },
  budget_pace: {
    title: pushSettingsTitle("budget_pace"),
    sub: (p) =>
      p.threshold && p.threshold >= 100
        ? `When a category reaches ${p.threshold}% of its plan`
        : `At ${p.threshold ?? 90}% and 100% of a category's plan`,
  },
  weekly_recap: {
    title: pushSettingsTitle("weekly_recap"),
    sub: (p) =>
      `${DAY_NAMES[Number((p.days ?? "0").split(",")[0])] ?? "Sundays"} ${clockText(p.time_of_day ?? "09:00")} · ${CHANNEL_TEXT[p.channel ?? "push"] ?? "push"}`,
  },
};
/** Low balance, milestones and group activity: as they happen, or one daily summary. */
export const DIGEST_TYPES = ["shortfall_risk", "milestone_reached", "group_activity"];

function withDelivery(p: NotificationSettingsOut["prefs"][string], what: string): string {
  return p.delivery === "daily"
    ? `${what} · one summary daily at ${clockText(p.time_of_day ?? "19:00")}`
    : `${what} · as it happens`;
}
const CHANNEL_TEXT: Record<string, string> = {
  push: "push",
  email: "email",
  both: "push and email",
};
export const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

export function clockText(clock: string): string {
  const [h, m] = clock.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function useNotificationSettings(options: { background?: boolean } = {}): {
  data: NotificationSettingsOut | null;
  error: ApiFailure | null;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<NotificationSettingsOut | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const background = options.background ?? false;
  const refresh = useCallback(async () => {
    const r = await clientFor(background).GET("/api/notifications/settings");
    const failure = failureOf(r);
    if (failure) {
      setError(failure);
      return;
    }
    setData(r.data ?? null);
    setError(null);
  }, [background]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const update = useCallback(async (patch: NotificationSettingsPatch) => {
    const r = await api.PUT("/api/notifications/settings", { body: patch });
    const failure = failureOf(r);
    if (failure) {
      setError(failure);
      return;
    }
    setData(r.data ?? null);
  }, []);
  return { data, error, update, refresh };
}
