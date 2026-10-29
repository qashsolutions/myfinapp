/** Port of stackd_rules/credit.py: card utilisation and the pay-in-full plan (chunk 3.5). */

import { addMonths, type Day, daysInMonth, daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { startBalance } from "./forecast.ts";
import { assertInt, ratioBps } from "./money.ts";

function optInt(value: unknown): number | null {
  return value === null || value === undefined ? null : assertInt(value);
}

function optDate(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(parseDate(value));
}

export interface Utilization {
  utilization_bps: number | null;
  balance_cents: number | null;
}

export function utilizationBps(
  statementBalanceCents: unknown,
  currentBalanceCents: unknown,
  limitCents: unknown,
): Utilization {
  const statement = optInt(statementBalanceCents);
  const current = optInt(currentBalanceCents);
  const limit = optInt(limitCents);
  if (limit !== null && limit < 0) throw new RuleError("invalid_amount");
  const balance = statement !== null ? statement : current;
  if (balance === null || !limit) return { utilization_bps: null, balance_cents: balance };
  const used = Math.max(0, balance);
  return { utilization_bps: ratioBps(used, limit), balance_cents: used };
}

export interface PayInFull {
  status: "plan" | "paid" | "no_balance" | "no_due_date" | "past_due" | "no_payday";
  remaining_cents: number;
  paid_cents: number;
  due_date: string | null;
  days_left: number | null;
  payments: Array<{ date: string; amount_cents: number }>;
}

export function payInFull(
  asOf: unknown,
  statementBalanceCents: unknown,
  statementDate: unknown,
  lastPaymentCents: unknown,
  lastPaymentDate: unknown,
  dueDate: unknown,
  paydays: unknown,
): PayInFull {
  const today = iso(parseDate(asOf));
  const balance = assertInt(statementBalanceCents);
  const stated = optDate(statementDate);
  const lastPaid = optInt(lastPaymentCents);
  const paidOn = optDate(lastPaymentDate);
  const due = optDate(dueDate);
  if (!Array.isArray(paydays)) throw new RuleError("invalid_paydays");
  // ISO dates sort as text.
  const days = [...new Set(paydays.map((d) => iso(parseDate(d))))].sort();
  if (lastPaid !== null && lastPaid < 0) throw new RuleError("invalid_amount");

  const paid = lastPaid && paidOn && stated && paidOn >= stated ? lastPaid : 0;
  const remaining = Math.max(0, balance - paid);
  const out: PayInFull = {
    status: "plan",
    remaining_cents: remaining,
    paid_cents: paid,
    due_date: due,
    days_left: due ? daysUntil(parseDate(today), parseDate(due)) : null,
    payments: [],
  };
  if (balance <= 0) return { ...out, status: "no_balance" };
  if (remaining === 0) return { ...out, status: "paid" };
  if (due === null) return { ...out, status: "no_due_date" };
  if (today > due) return { ...out, status: "past_due" };
  const window = days.filter((d) => today <= d && d <= due);
  if (window.length === 0)
    return { ...out, status: "no_payday", payments: [{ date: due, amount_cents: remaining }] };
  const share = Math.floor(remaining / window.length);
  const odd = remaining % window.length;
  return {
    ...out,
    payments: window.map((date, i) => ({ date, amount_cents: share + (i < odd ? 1 : 0) })),
  };
}

// --- card trend and credit habits (debt & credit, October 28, 2026) -------------------------

const MAX_WINDOW_MONTHS = 120;

function windowMonths(value: unknown): number {
  const months = assertInt(value, "invalid_months");
  if (months < 1 || months > MAX_WINDOW_MONTHS) throw new RuleError("invalid_months");
  return months;
}

function monthKey(day: Day): string {
  return iso(day).slice(0, 7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CardRow {
  date: Day;
  direction: "in" | "out";
  cents: number;
}

function cardEntry(raw: unknown): CardRow {
  if (!isRecord(raw)) throw new RuleError("invalid_entry");
  const direction = raw.direction;
  if (direction !== "in" && direction !== "out") throw new RuleError("invalid_direction");
  const cents = assertInt(raw.amount_cents, "invalid_amount");
  if (cents < 0) throw new RuleError("invalid_amount");
  return { date: parseDate(raw.date), direction, cents };
}

export interface CardMonth {
  month: string;
  spent_cents: number;
  paid_cents: number;
  net_cents: number;
}

export interface CardTrend {
  months: CardMonth[];
  last_month: CardMonth | null;
  trend: "growing" | "shrinking" | "steady" | null;
}

/** Port of credit.card_trend: one card's spent against paid per whole month. */
export function cardTrend(entries: unknown, asOf: unknown, months: unknown): CardTrend {
  const today = parseDate(asOf);
  const span = windowMonths(months);
  if (!Array.isArray(entries)) throw new RuleError("invalid_entries");
  const rows = entries.map(cardEntry);
  const thisMonth: Day = { y: today.y, m: today.m, d: 1 };
  let first: Day | null = null;
  for (const r of rows) if (first === null || daysUntil(r.date, first) > 0) first = r.date;
  const out: CardMonth[] = [];
  for (let back = span; back > 0; back -= 1) {
    const start = addMonths(thisMonth, -back);
    if (first === null || daysUntil({ y: first.y, m: first.m, d: 1 }, start) < 0) continue;
    const key = monthKey(start);
    let spent = 0;
    let paid = 0;
    for (const r of rows) {
      if (monthKey(r.date) !== key) continue;
      if (r.direction === "out") spent += r.cents;
      else paid += r.cents;
    }
    out.push({ month: key, spent_cents: spent, paid_cents: paid, net_cents: spent - paid });
  }
  let trend: CardTrend["trend"] = null;
  if (out.length >= 3) {
    const last3 = out.slice(-3);
    if (last3.every((m) => m.spent_cents > m.paid_cents)) trend = "growing";
    else if (last3.every((m) => m.paid_cents > m.spent_cents)) trend = "shrinking";
    else trend = "steady";
  }
  return { months: out, last_month: out.at(-1) ?? null, trend };
}

export interface CreditHabits {
  status: "steady" | "building" | "missed" | null;
  checked: number;
  unknown: number;
  on_time: number;
  on_time_streak: number;
  missed: string[];
  latest_due_date: string | null;
  next_due_date: string | null;
  paid_in_full_streak: number | null;
  utilization_bps: number | null;
  under_guide: boolean | null;
  /** Every due date in the window, in date order, with its result (October 29, 2026). */
  dues: Array<{ due_date: string; result: "on_time" | "missed" | "unknown" }>;
}

interface DueResult {
  due: string;
  onTime: boolean;
  inFull: boolean | null;
}

/** Port of credit.habits: on-time payments, the limit used and paying in full (see Python). */
export function habits(
  dueDates: unknown,
  dueDay: unknown,
  payments: unknown,
  minimumCents: unknown,
  statements: unknown,
  statementBalanceCents: unknown,
  currentBalanceCents: unknown,
  limitCents: unknown,
  asOf: unknown,
  months: unknown,
  guideBps: unknown,
  since: unknown = null,
  balanceHistory: unknown = null,
  until: unknown = null,
): CreditHabits {
  const today = parseDate(asOf);
  const span = windowMonths(months);
  const guide = assertInt(guideBps, "invalid_amount");
  if (guide < 0) throw new RuleError("invalid_amount");
  const first = since === null || since === undefined ? null : parseDate(since);
  if (!Array.isArray(dueDates)) throw new RuleError("invalid_dates");
  if (!Array.isArray(payments)) throw new RuleError("invalid_payments");
  const dues = new Map<string, Day>();
  const addDue = (day: Day) => dues.set(iso(day), day);
  for (const d of dueDates) addDue(parseDate(d));
  const start = addMonths(today, -span);
  const last = until === null || until === undefined ? null : parseDate(until);
  const day = dueDay === null || dueDay === undefined ? null : assertInt(dueDay, "invalid_day");
  if (day !== null && (day < 1 || day > 31)) throw new RuleError("invalid_day");
  const minimum = optInt(minimumCents);
  if (minimum !== null && minimum < 0) throw new RuleError("invalid_amount");
  const owedByDue = new Map<string, number>();
  const minimumByDue = new Map<string, number>();
  if (statements !== null && statements !== undefined) {
    if (!Array.isArray(statements)) throw new RuleError("invalid_statements");
    for (const raw of statements) {
      if (!isRecord(raw)) throw new RuleError("invalid_statements");
      const due = parseDate(raw.due_date);
      addDue(due);
      const owed = optInt(raw.balance_cents);
      if (owed !== null) owedByDue.set(iso(due), owed);
      const ownMin = optInt(raw.minimum_cents);
      if (ownMin !== null) {
        if (ownMin < 0) throw new RuleError("invalid_amount");
        minimumByDue.set(iso(due), ownMin);
      }
    }
  }
  if (day !== null) {
    // The own due day fills only months with no known due date (see Python), from the month
    // before the window through the month after as_of.
    const known = new Set([...dues.values()].map((d) => d.y * 100 + d.m));
    const lead = addMonths({ y: start.y, m: start.m, d: 1 }, -1);
    for (let step = 0; step < span + 3; step += 1) {
      const month = addMonths(lead, step);
      if (!known.has(month.y * 100 + month.m))
        addDue({ ...month, d: Math.min(day, daysInMonth(month)) });
    }
  }
  const paid = payments.map((raw) => {
    if (!isRecord(raw)) throw new RuleError("invalid_payment");
    const cents = assertInt(raw.cents, "invalid_amount");
    if (cents < 0) throw new RuleError("invalid_amount");
    return { when: parseDate(raw.date), cents };
  });

  const ordered = [...dues.values()].sort((a, b) => daysUntil(b, a));
  const history = parseHistory(balanceHistory);
  const window = ordered.filter(
    (d) =>
      daysUntil(start, d) >= 0 &&
      daysUntil(d, today) > 0 &&
      (first === null || daysUntil(first, d) >= 0),
  );
  const checked: Day[] = [];
  let unknown = 0;
  const unknownDates = new Set<string>();
  for (const d of window) {
    if (history !== null && !owedByDue.has(iso(d))) {
      const owedThen = owedOn(history, d);
      if (owedThen === null) {
        unknown += 1;
        unknownDates.add(iso(d));
        continue;
      }
      if (owedThen === 0) owedByDue.set(iso(d), 0);
    }
    checked.push(d);
  }
  const results: DueResult[] = [];
  for (const d of checked) {
    const after = ordered.filter((x) => daysUntil(x, d) > 0).at(-1) ?? addMonths(d, -1);
    let total = 0;
    for (const p of paid) {
      if (daysUntil(after, p.when) > 0 && daysUntil(p.when, d) >= 0) total += p.cents;
    }
    const key = iso(d);
    const owed = owedByDue.get(key) ?? null;
    const need = minimumByDue.get(key) ?? minimum;
    if (owed !== null && owed <= 0) {
      results.push({ due: key, onTime: true, inFull: true });
      continue;
    }
    const onTime = need ? total >= need : total > 0;
    if (!onTime && last !== null && daysUntil(last, d) > 0) {
      // Past what the card's data reaches: its payment may simply not be in yet.
      unknown += 1;
      unknownDates.add(key);
      continue;
    }
    results.push({ due: key, onTime, inFull: owed === null ? null : total >= owed });
  }

  const newestFirst = [...results].reverse();
  let streak = 0;
  for (const r of newestFirst) {
    if (!r.onTime) break;
    streak += 1;
  }
  let fullStreak: number | null = null;
  for (const r of newestFirst) {
    const inFull = r.inFull;
    if (inFull === null) break;
    if (!inFull) {
      fullStreak = fullStreak ?? 0;
      break;
    }
    fullStreak = (fullStreak ?? 0) + 1;
  }
  const latest = results.at(-1) ?? null;
  let status: CreditHabits["status"] = null;
  if (latest) {
    if (streak === results.length) status = "steady";
    else if (!latest.onTime) status = "missed";
    else status = "building";
  }
  const next = ordered.find((d) => daysUntil(today, d) >= 0) ?? null;
  const util = utilizationBps(
    statementBalanceCents,
    currentBalanceCents,
    limitCents,
  ).utilization_bps;
  return {
    status,
    checked: results.length,
    unknown,
    on_time: results.filter((r) => r.onTime).length,
    on_time_streak: streak,
    missed: results.filter((r) => !r.onTime).map((r) => r.due),
    latest_due_date: latest ? latest.due : null,
    next_due_date: next ? iso(next) : null,
    paid_in_full_streak: fullStreak,
    utilization_bps: util,
    under_guide: util === null ? null : util <= guide,
    dues: window.map((d) => {
      const key = iso(d);
      const r = results.find((x) => x.due === key);
      return {
        due_date: key,
        result: unknownDates.has(key) || !r ? "unknown" : r.onTime ? "on_time" : "missed",
      };
    }),
  };
}

interface History {
  anchors: Array<{ day: Day; index: number; raw: unknown }>;
  entries: unknown[];
  rows: CardRow[];
}

function parseHistory(raw: unknown): History | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new RuleError("invalid_history");
  const { anchors, entries } = raw;
  if (!Array.isArray(anchors) || !Array.isArray(entries)) throw new RuleError("invalid_history");
  const parsed = anchors.map((a, index) => {
    if (!isRecord(a)) throw new RuleError("invalid_anchor");
    return { day: parseDate(a.as_of), index, raw: a as unknown };
  });
  return { anchors: parsed, entries, rows: entries.map(cardEntry) };
}

/** Port of credit._owed_on: what was owed at the end of `day`, or null with no anchor before. */
function owedOn(history: History, day: Day): number | null {
  let anchor: History["anchors"][number] | null = null;
  for (const a of history.anchors) {
    if (daysUntil(a.day, day) < 0) continue;
    if (anchor === null || daysUntil(anchor.day, a.day) >= 0) anchor = a;
  }
  if (anchor === null) return null;
  const upto = history.entries.filter((_, i) => {
    const row = history.rows[i];
    return row !== undefined && daysUntil(row.date, day) >= 0;
  });
  const balance = startBalance(anchor.raw, upto).balance_cents ?? 0;
  return Math.max(0, -balance);
}
