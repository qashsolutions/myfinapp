/** Port of stackd_rules/alerts.py: the device-side alert schedule (dates, types, keys only). */

import { addDays, type Day, daysUntil, iso, parseDate, weekday } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { fnv1a64 } from "./fingerprint.ts";
import { assertInt, mul, roundDiv } from "./money.ts";
import { compareLocal, fmtLocal, type Local, parseClock, parseLocal } from "./notify.ts";
import { compareText, utf8 } from "./text.ts";

export const HORIZON_DAYS = 30;
export const SEND_TIME = "09:00"; // dated alerts, unless the person picks their own time (`time`)

export interface ScheduledAlert {
  type: string;
  due_local: string;
  dedupe_key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TAG = /^[a-p]{16}$/;

/**
 * Port of alerts.tag: 16 letters a–p from FNV-1a 64 of `salt:value`, so a key can name a
 * category without the server learning which one (the salt is a random value on the device).
 */
export function tag(value: unknown, salt: unknown): string {
  if (typeof value !== "string" || !value || typeof salt !== "string" || !salt)
    throw new RuleError("invalid_inputs");
  const hex = fnv1a64(utf8(`${salt}:${value}`, "invalid_inputs"))
    .toString(16)
    .padStart(16, "0");
  return Array.from(hex, (c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

function at(day: Day, clock: unknown): Local {
  return { day, minute: parseClock(clock) };
}

function pref(prefs: Record<string, unknown>, name: string): Record<string, unknown> {
  const p = prefs[name];
  if (p === undefined || p === null) return { enabled: false };
  if (!isRecord(p) || typeof p.enabled !== "boolean") throw new RuleError("invalid_prefs");
  return p;
}

/** Python's dict.get(key, fallback): the fallback only when the key is missing, never for null. */
function opt(p: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return p[key] === undefined ? fallback : p[key];
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RuleError("invalid_inputs");
  return value;
}

/** A yes / no field: true, false, or left out; a truthy 1 or [] is invalid_inputs. */
function flag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new RuleError("invalid_inputs");
  return value;
}

/** Python's (weekday() + 1) % 7: 0 = Sunday … 6 = Saturday. dates.weekday is 0 = Monday. */
function sundayFirst(day: Day): number {
  return (weekday(day) + 1) % 7;
}

export function schedule(inputs: unknown): { alerts: ScheduledAlert[] } {
  if (!isRecord(inputs)) throw new RuleError("invalid_inputs");
  const now = parseLocal(inputs.now_local);
  const today = now.day;
  const horizon = addDays(today, HORIZON_DAYS);
  const prefs = inputs.prefs;
  if (!isRecord(prefs)) throw new RuleError("invalid_prefs");
  const out: ScheduledAlert[] = [];
  const add = (type: string, due: Local, key: string) => {
    const d = iso(due.day);
    if (d >= iso(today) && d <= iso(horizon))
      out.push({ type, due_local: fmtLocal(due), dedupe_key: key });
  };

  const up = pref(prefs, "upcoming_expense");
  if (up.enabled) {
    const lead = assertInt(opt(up, "lead_days", 3));
    if (lead < 0) throw new RuleError("invalid_prefs");
    for (const item of list(inputs.upcoming)) {
      if (!isRecord(item) || item.kind !== "bill" || flag(item.matched)) continue;
      const when = parseDate(item.date);
      if (typeof item.series_id !== "string") throw new RuleError("invalid_inputs");
      let due = at(addDays(when, -lead), opt(up, "time", SEND_TIME));
      if (compareLocal(due, now) < 0) due = now;
      add("upcoming_expense", due, `upcoming:${item.series_id}:${iso(when)}`);
    }
  }

  const short = inputs.shortfall;
  if (pref(prefs, "shortfall_risk").enabled && short !== null && short !== undefined) {
    if (!isRecord(short)) throw new RuleError("invalid_inputs");
    const first = parseDate(short.first_short_date);
    assertInt(short.short_by_cents); // still checked: a bad input is still invalid
    add("shortfall_risk", now, `shortfall:${iso(first)}`);
  }

  const chk = pref(prefs, "challenge_checkin");
  if (chk.enabled) {
    const clock = opt(chk, "time", "19:30");
    for (const ch of list(inputs.challenges)) {
      if (!isRecord(ch) || typeof ch.group_id !== "string") throw new RuleError("invalid_inputs");
      const end = parseDate(ch.end_date);
      const last = iso(end) < iso(horizon) ? end : horizon;
      for (let day = today; iso(day) <= iso(last); day = addDays(day, 1)) {
        const due = at(day, clock);
        if (compareLocal(due, now) >= 0)
          add("challenge_checkin", due, `checkin:${ch.group_id}:${iso(day)}`);
      }
    }
  }

  const behind = pref(prefs, "goal_behind_pace");
  if (behind.enabled) {
    const periods = assertInt(opt(behind, "periods", 1));
    if (periods < 1) throw new RuleError("invalid_prefs");
    for (const g of list(inputs.goals)) {
      if (!isRecord(g) || typeof g.id !== "string") throw new RuleError("invalid_inputs");
      const start = parseDate(g.start_date);
      const end = parseDate(g.end_date);
      const target = assertInt(g.target_cents);
      const current = assertInt(g.current_cents);
      if (iso(end) <= iso(start) || target <= 0 || iso(today) < iso(start)) continue;
      const weeksTotal = Math.max(1, Math.ceil(daysUntil(start, end) / 7));
      const pace = roundDiv(target, weeksTotal);
      const weeksElapsed = Math.floor(daysUntil(start, today) / 7);
      const byNow = mul(pace, weeksElapsed);
      const expected = byNow < BigInt(target) ? byNow : BigInt(target);
      if (expected - BigInt(current) >= mul(periods, pace) && pace > 0)
        add("goal_behind_pace", now, `behind:${g.id}:${weeksElapsed}`);
    }
  }

  if (pref(prefs, "milestone_reached").enabled) {
    for (const m of list(inputs.milestones)) {
      if (!isRecord(m) || typeof m.goal_id !== "string" || typeof m.key !== "string")
        throw new RuleError("invalid_inputs");
      add("milestone_reached", now, `milestone:${m.goal_id}:${m.key}`);
    }
  }

  const budget = pref(prefs, "budget_pace");
  if (budget.enabled) {
    const atTime = at(today, opt(budget, "time", SEND_TIME));
    const due = compareLocal(atTime, now) >= 0 ? atTime : now;
    const month = iso(today).slice(0, 7);
    for (const item of list(inputs.budget)) {
      if (!isRecord(item)) throw new RuleError("invalid_inputs");
      const label = item.tag;
      if (typeof label !== "string" || !TAG.test(label)) throw new RuleError("invalid_inputs");
      const level = assertInt(item.level_bps);
      if (level <= 0) throw new RuleError("invalid_inputs");
      add("budget_pace", due, `budget:${month}:${label}:${level}`);
    }
  }

  const recap = pref(prefs, "weekly_recap");
  if (recap.enabled) {
    const wd = assertInt(opt(recap, "day", 0));
    if (wd < 0 || wd > 6) throw new RuleError("invalid_prefs");
    const clock = opt(recap, "time", "09:00");
    let day = today;
    for (let i = 0; i < 8; i += 1) {
      if (sundayFirst(day) === wd) {
        const due = at(day, clock);
        if (compareLocal(due, now) >= 0) {
          add("weekly_recap", due, `recap:${iso(day)}`);
          break;
        }
      }
      day = addDays(day, 1);
    }
  }

  out.sort(
    (a, b) =>
      compareText(a.due_local, b.due_local) ||
      compareText(a.type, b.type) ||
      compareText(a.dedupe_key, b.dedupe_key),
  );
  return { alerts: out };
}
