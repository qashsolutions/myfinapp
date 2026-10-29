/** Port of stackd_rules/notify.py: the notification send decision. Local wall-clock strings. */

import { addDays, type Day, daysInMonth, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";
import { compareText } from "./text.ts";

export const TYPES = [
  "upcoming_expense",
  "shortfall_risk",
  "challenge_checkin",
  "goal_behind_pace",
  "milestone_reached",
  "group_activity",
  "weekly_recap",
  "budget_pace",
] as const;
export type AlertType = (typeof TYPES)[number];

const LOCAL = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/;
const CLOCK = /^[0-9]{2}:[0-9]{2}$/;

/** A local wall-clock moment: the day plus minutes since midnight. */
export interface Local {
  day: Day;
  minute: number;
}

export function parseLocal(value: unknown): Local {
  if (typeof value !== "string" || !LOCAL.test(value)) throw new RuleError("invalid_time");
  let day: Day;
  try {
    day = parseDate(value.slice(0, 10));
  } catch {
    throw new RuleError("invalid_time");
  }
  const minute = parseClock(value.slice(11, 16));
  return { day, minute };
}

export function parseClock(value: unknown): number {
  if (typeof value !== "string" || !CLOCK.test(value)) throw new RuleError("invalid_time");
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  if (hours > 23 || minutes > 59) throw new RuleError("invalid_time");
  return hours * 60 + minutes;
}

export function fmtLocal(value: Local): string {
  const h = String(Math.floor(value.minute / 60)).padStart(2, "0");
  const m = String(value.minute % 60).padStart(2, "0");
  return `${iso(value.day)}T${h}:${m}`;
}

export function compareLocal(a: Local, b: Local): number {
  const d = compareText(iso(a.day), iso(b.day));
  return d !== 0 ? d : a.minute - b.minute;
}

export function inQuietHours(minuteOfDay: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return start <= minuteOfDay && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

export function quietEndAfter(now: Local, _start: number, end: number): Local {
  const candidate: Local = { day: now.day, minute: end };
  if (compareLocal(candidate, now) <= 0) return { day: addDays(now.day, 1), minute: end };
  return candidate;
}

export interface Decision {
  action: "send" | "skip" | "wait" | "defer" | "summary";
  reason:
    | "ok"
    | "duplicate"
    | "disabled"
    | "not_due"
    | "paused"
    | "quiet_hours"
    | "daily_max"
    | "daily_digest";
  send_at_local: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decide(
  candidate: unknown,
  settings: unknown,
  prefs: unknown,
  sent: unknown,
  nowLocal: unknown,
): Decision {
  if (!isRecord(candidate) || !(TYPES as readonly unknown[]).includes(candidate.type))
    throw new RuleError("invalid_candidate");
  const key = candidate.dedupe_key;
  if (typeof key !== "string" || key === "") throw new RuleError("invalid_candidate");
  const due = parseLocal(candidate.due_local);
  const now = parseLocal(nowLocal);
  if (!isRecord(settings) || !isRecord(prefs)) throw new RuleError("invalid_settings");
  // A switch is on or off: only true and false, and a type left out is off.
  if (Object.values(prefs).some((on) => typeof on !== "boolean"))
    throw new RuleError("invalid_settings");
  const quietStart = parseClock(settings.quiet_start);
  const quietEnd = parseClock(settings.quiet_end);
  const dailyMax = assertInt(settings.daily_max);
  if (dailyMax < 0) throw new RuleError("invalid_settings");
  const paused =
    settings.paused_until === null || settings.paused_until === undefined
      ? null
      : parseLocal(settings.paused_until);
  const digest = settings.digest === undefined ? {} : settings.digest;
  if (
    !isRecord(digest) ||
    Object.keys(digest).some((k) => !(TYPES as readonly string[]).includes(k))
  )
    throw new RuleError("invalid_settings");
  const digestAt = digest[candidate.type as string];
  const digestMinute = digestAt === null || digestAt === undefined ? null : parseClock(digestAt);
  if (!isRecord(sent)) throw new RuleError("invalid_sent");
  const sentKeys = sent.keys;
  if (!Array.isArray(sentKeys) || sentKeys.some((k) => typeof k !== "string"))
    throw new RuleError("invalid_sent");
  const sentToday = assertInt(sent.today);
  if (sentToday < 0) throw new RuleError("invalid_sent");

  if (sentKeys.includes(key)) return { action: "skip", reason: "duplicate", send_at_local: null };
  if (prefs[candidate.type as string] !== true)
    return { action: "skip", reason: "disabled", send_at_local: null };
  if (compareLocal(due, now) > 0)
    return { action: "wait", reason: "not_due", send_at_local: fmtLocal(due) };
  if (paused !== null && compareLocal(paused, now) > 0)
    return { action: "skip", reason: "paused", send_at_local: null };
  if (digestMinute !== null) {
    // "One daily summary": today's at the chosen time, or tomorrow's once it has passed.
    const day = now.minute > digestMinute ? addDays(now.day, 1) : now.day;
    return {
      action: "summary",
      reason: "daily_digest",
      send_at_local: fmtLocal({ day, minute: digestMinute }),
    };
  }
  if (inQuietHours(now.minute, quietStart, quietEnd))
    return {
      action: "defer",
      reason: "quiet_hours",
      send_at_local: fmtLocal(quietEndAfter(now, quietStart, quietEnd)),
    };
  if (dailyMax > 0 && sentToday >= dailyMax)
    return {
      action: "summary",
      reason: "daily_max",
      send_at_local: fmtLocal({ day: addDays(now.day, 1), minute: quietEnd }),
    };
  return { action: "send", reason: "ok", send_at_local: fmtLocal(now) };
}

export { daysInMonth };
