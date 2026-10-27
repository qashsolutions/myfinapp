/**
 * The device's alert schedule (docs/spec.md "Notifications" → Delivery): computed here from
 * the device's own data through the `alerts.schedule` rule, then registered with the server
 * as dates, types and dedupe keys only. Amounts and merchants never leave.
 */

import {
  type AlertInputs,
  alertsSchedule,
  goalProgress,
  type Projection,
  payInFull,
  type Upcoming,
} from "../engine/bridge.ts";
import { api, failureOf, type NotificationSettingsOut } from "./api.ts";
import type { Goal, StackdDb } from "./db.ts";

export const LAST_HASH_KEY = "alerts.last_hash";
export const NOTIFIED_MILESTONES_KEY = "alerts.notified_milestones";

export interface ScheduleSources {
  nowLocal: string; // "YYYY-MM-DDTHH:MM" in the user's zone
  asOf: string;
  upcoming: Upcoming | null;
  projection: Projection | null;
  challenges: Array<{ group_id: string; end_date: string }>;
  goals: Goal[];
  milestonesReached: Array<{ goal_id: string; key: string }>;
  prefs: NotificationSettingsOut["prefs"];
}

/** Local wall-clock "YYYY-MM-DDTHH:MM" for a Date in the browser's zone. */
export function localStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** The UTC instant for a local wall-clock stamp, in the browser's zone. */
export function localToUtc(local: string): string {
  const [date, time] = local.split("T") as [string, string];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, h, mi).toISOString();
}

/**
 * Chunk 3.5: a linked card with a statement balance still to pay joins the schedule as an
 * upcoming bill on its due date, so the Upcoming expense alert (and its lead days, quiet hours
 * and limits) covers it. Only the date and a `card-<account>` key leave the device.
 */
async function cardDueItems(db: StackdDb, asOf: string): Promise<AlertInputs["upcoming"]> {
  const [details, accounts] = await Promise.all([db.card_details.toArray(), db.accounts.toArray()]);
  const linked = new Set(accounts.filter((a) => a.linked).map((a) => a.id));
  const items: AlertInputs["upcoming"] = [];
  for (const d of details) {
    if (!linked.has(d.account_id) || !d.due_date || d.statement_balance_cents === null) continue;
    const plan = await payInFull({
      asOf,
      statementBalanceCents: d.statement_balance_cents,
      statementDate: d.statement_date,
      lastPaymentCents: d.last_payment_cents,
      lastPaymentDate: d.last_payment_date,
      dueDate: d.due_date,
      paydays: [],
    });
    if (plan.status !== "plan" && plan.status !== "no_payday") continue;
    items.push({
      series_id: `card-${d.account_id}`,
      date: d.due_date,
      kind: "bill",
      matched: false,
    });
  }
  return items;
}

export async function buildInputs(db: StackdDb, sources: ScheduleSources): Promise<AlertInputs> {
  const goals: AlertInputs["goals"] = [];
  for (const g of sources.goals) {
    if (g.kind !== "save" || g.status !== "active" || !g.end_date || !g.target_cents) continue;
    const events = (await db.goal_events.where("goal_id").equals(g.id).toArray())
      .sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
      .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents }));
    const p = await goalProgress(
      {
        kind: "save",
        target_cents: g.target_cents,
        start_date: g.start_date,
        end_date: g.end_date,
      },
      events,
      sources.asOf,
    );
    goals.push({
      id: g.id,
      kind: "save",
      start_date: g.start_date,
      end_date: g.end_date,
      target_cents: g.target_cents,
      current_cents: p.current,
    });
  }
  const prefs = sources.prefs;
  return {
    now_local: sources.nowLocal,
    upcoming: [
      ...(sources.upcoming?.items ?? []).map((i) => ({
        series_id: i.series_id,
        date: i.date,
        kind: i.kind,
        matched: i.matched,
      })),
      ...(await cardDueItems(db, sources.asOf)),
    ],
    shortfall:
      sources.projection?.shortfall && sources.projection.first_short_date
        ? {
            first_short_date: sources.projection.first_short_date,
            short_by_cents: sources.projection.short_by_cents,
          }
        : null,
    challenges: sources.challenges,
    goals,
    milestones: sources.milestonesReached,
    prefs: {
      upcoming_expense: {
        enabled: prefs.upcoming_expense?.enabled ?? false,
        lead_days: prefs.upcoming_expense?.lead_days ?? 3,
      },
      shortfall_risk: { enabled: prefs.shortfall_risk?.enabled ?? false },
      challenge_checkin: {
        enabled: prefs.challenge_checkin?.enabled ?? false,
        time: prefs.challenge_checkin?.time_of_day ?? "19:30",
      },
      goal_behind_pace: {
        enabled: prefs.goal_behind_pace?.enabled ?? false,
        periods: prefs.goal_behind_pace?.threshold ?? 1,
      },
      milestone_reached: { enabled: prefs.milestone_reached?.enabled ?? false },
      weekly_recap: {
        enabled: prefs.weekly_recap?.enabled ?? false,
        day: Number((prefs.weekly_recap?.days ?? "0").split(",")[0]),
        time: prefs.weekly_recap?.time_of_day ?? "09:00",
      },
    },
  };
}

/** Computes the schedule and registers it when it changed since last time. */
export async function syncAlertSchedule(
  db: StackdDb,
  sources: ScheduleSources,
): Promise<number | null> {
  const inputs = await buildInputs(db, sources);
  const { alerts } = await alertsSchedule(inputs);
  const items = alerts.map((a) => ({
    due_at: localToUtc(a.due_local),
    type: a.type,
    dedupe_key: a.dedupe_key,
  }));
  const hash = JSON.stringify(items);
  const last = (await db.settings.get(LAST_HASH_KEY))?.value;
  if (last === hash) return null;
  const r = await api.PUT("/api/alerts/schedule", { body: { items: items as never } });
  if (failureOf(r)) return null;
  await db.settings.put({ key: LAST_HASH_KEY, value: hash, updated_at: new Date().toISOString() });
  return items.length;
}
