/** Port of stackd_rules/credit.py: card utilisation and the pay-in-full plan (chunk 3.5). */

import { daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
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
