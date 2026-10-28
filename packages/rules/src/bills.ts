/** Port of stackd_rules/bills.py: the debt avalanche order. */

import { addMonths, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, mul, roundDiv } from "./money.ts";
import { compareText } from "./text.ts";

export interface Debt {
  id: string;
  label: string;
  balance_cents: number;
  apr_bps: number;
  min_payment_cents: number;
}

function debt(raw: unknown): Debt {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_debt");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "" || typeof r.label !== "string")
    throw new RuleError("invalid_debt");
  const balance = assertInt(r.balance_cents);
  const apr = assertInt(r.apr_bps);
  const minimum = assertInt(r.min_payment_cents);
  if (balance < 0 || apr < 0 || minimum < 0) throw new RuleError("invalid_amount");
  return {
    id: r.id,
    label: r.label,
    balance_cents: balance,
    apr_bps: apr,
    min_payment_cents: minimum,
  };
}

export interface AvalancheOrder {
  order: Array<Debt & { rank: number }>;
  total_balance_cents: number;
  total_min_payment_cents: number;
  max_apr_bps: number | null;
}

export function avalancheOrder(debts: unknown): AvalancheOrder {
  if (!Array.isArray(debts)) throw new RuleError("invalid_debts");
  const rows = debts.map(debt);
  rows.sort(
    (a, b) =>
      b.apr_bps - a.apr_bps ||
      a.balance_cents - b.balance_cents ||
      compareText(a.label, b.label) ||
      compareText(a.id, b.id),
  );
  return {
    order: rows.map((d, i) => ({ ...d, rank: i + 1 })),
    total_balance_cents: rows.reduce((s, d) => s + d.balance_cents, 0),
    total_min_payment_cents: rows.reduce((s, d) => s + d.min_payment_cents, 0),
    max_apr_bps: rows.length ? Math.max(...rows.map((d) => d.apr_bps)) : null,
  };
}

const MAX_MONTHS = 600; // fifty years: past this the plan is not a plan

export interface PayoffDebt {
  id: string;
  label: string;
  rank: number;
  payoff_month: string | null;
  months: number | null;
  interest_cents: number | null;
}

export interface PayoffPlan {
  stalled: boolean;
  months: number | null;
  debt_free_month: string | null;
  monthly_budget_cents: number;
  total_interest_cents: number | null;
  total_paid_cents: number | null;
  series_cents: number[];
  order: PayoffDebt[];
}

function monthLabel(asOf: string, monthsAhead: number): string {
  const first = { ...parseDate(asOf), d: 1 };
  const day = addMonths(first, monthsAhead);
  return `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}`;
}

/** Port of bills.payoff_plan: the avalanche month by month (see the Python docstring). */
export function payoffPlan(debts: unknown, extraCents: unknown, asOf: unknown): PayoffPlan {
  if (typeof asOf !== "string") throw new RuleError("invalid_date");
  parseDate(asOf);
  const extra = assertInt(extraCents, "invalid_amount");
  if (extra < 0) throw new RuleError("invalid_amount");
  const order = avalancheOrder(debts).order;
  const budget = order.reduce((sum, d) => sum + d.min_payment_cents, 0) + extra;
  const balances = new Map(order.map((d) => [d.id, d.balance_cents]));
  const interest = new Map(order.map((d) => [d.id, 0]));
  const paidMonth = new Map<string, number>(
    order.filter((d) => d.balance_cents === 0).map((d) => [d.id, 0]),
  );
  const series: number[] = [];
  let month = 0;
  const stalled = (): PayoffPlan => ({
    stalled: true,
    months: null,
    debt_free_month: null,
    monthly_budget_cents: budget,
    total_interest_cents: null,
    total_paid_cents: null,
    series_cents: [],
    order: order.map((d) => ({
      id: d.id,
      label: d.label,
      rank: d.rank,
      payoff_month: null,
      months: null,
      interest_cents: null,
    })),
  });
  while (paidMonth.size < order.length) {
    month += 1;
    if (month > MAX_MONTHS) return stalled();
    let remaining = budget;
    for (const d of order) {
      if (paidMonth.has(d.id)) continue;
      const balance = balances.get(d.id) ?? 0;
      const accrued = roundDiv(mul(balance, d.apr_bps), 120000);
      interest.set(d.id, (interest.get(d.id) ?? 0) + accrued);
      const withInterest = balance + accrued;
      const payment = Math.min(d.min_payment_cents, withInterest, remaining);
      balances.set(d.id, withInterest - payment);
      remaining -= payment;
    }
    for (const d of order) {
      if (paidMonth.has(d.id) || remaining <= 0) continue;
      const balance = balances.get(d.id) ?? 0;
      const payment = Math.min(balance, remaining);
      balances.set(d.id, balance - payment);
      remaining -= payment;
    }
    for (const d of order)
      if (!paidMonth.has(d.id) && balances.get(d.id) === 0) paidMonth.set(d.id, month);
    let total = 0;
    for (const v of balances.values()) total += v;
    series.push(total);
  }
  let totalInterest = 0;
  for (const v of interest.values()) totalInterest += v;
  return {
    stalled: false,
    months: month,
    debt_free_month: order.length ? monthLabel(asOf, month) : null,
    monthly_budget_cents: budget,
    total_interest_cents: totalInterest,
    total_paid_cents: order.reduce((sum, d) => sum + d.balance_cents, 0) + totalInterest,
    series_cents: series,
    order: order.map((d) => ({
      id: d.id,
      label: d.label,
      rank: d.rank,
      payoff_month: monthLabel(asOf, paidMonth.get(d.id) ?? 0),
      months: paidMonth.get(d.id) ?? 0,
      interest_cents: interest.get(d.id) ?? 0,
    })),
  };
}

// --- consolidation what-if (fast-follow 8) -------------------------------------------------

export interface Consolidation {
  today: { stalled: boolean; months: number | null; interest_cents: number | null };
  consolidated: {
    stalled: boolean;
    months: number | null;
    interest_cents: number | null;
    fee_cents: number;
    cost_cents: number | null;
    balance_after_promo_cents: number | null;
  };
  saves_cents: number | null;
}

/** Port of bills.consolidation: today's avalanche against one balance at the offer's rates. */
export function consolidation(
  debts: unknown,
  offer: unknown,
  paymentCents: unknown,
  asOf: unknown,
): Consolidation {
  const payment = assertInt(paymentCents, "invalid_amount");
  if (typeof offer !== "object" || offer === null || Array.isArray(offer))
    throw new RuleError("invalid_offer");
  const o = offer as Record<string, unknown>;
  const apr = assertInt(o.apr_bps, "invalid_offer");
  const feeBps = assertInt(o.fee_bps, "invalid_offer");
  const promoMonths = assertInt(o.promo_months, "invalid_offer");
  const promoApr = assertInt(o.promo_apr_bps, "invalid_offer");
  if (Math.min(apr, feeBps, promoMonths, promoApr) < 0) throw new RuleError("invalid_offer");
  const order = avalancheOrder(debts).order;
  const minimums = order.reduce((sum, d) => sum + d.min_payment_cents, 0);
  if (payment < minimums) throw new RuleError("payment_below_minimums");
  const today = payoffPlan(debts, payment - minimums, asOf);
  const total = order.reduce((sum, d) => sum + d.balance_cents, 0);
  const fee = roundDiv(mul(total, feeBps), 10000);
  let balance = total + fee;
  let interest = 0;
  let month = 0;
  let afterPromo: number | null = null;
  let stalled = false;
  while (balance > 0) {
    month += 1;
    if (month > MAX_MONTHS) {
      stalled = true;
      break;
    }
    const rate = month <= promoMonths ? promoApr : apr;
    const accrued = roundDiv(mul(balance, rate), 120000);
    interest += accrued;
    balance += accrued;
    balance -= Math.min(payment, balance);
    if (promoMonths && month === promoMonths) afterPromo = balance;
  }
  if (promoMonths && month < promoMonths && !stalled) afterPromo = 0;
  return {
    today: {
      stalled: today.stalled,
      months: today.months,
      interest_cents: today.total_interest_cents,
    },
    consolidated: stalled
      ? {
          stalled: true,
          months: null,
          interest_cents: null,
          fee_cents: fee,
          cost_cents: null,
          balance_after_promo_cents: null,
        }
      : {
          stalled: false,
          months: month,
          interest_cents: interest,
          fee_cents: fee,
          cost_cents: interest + fee,
          balance_after_promo_cents: afterPromo,
        },
    saves_cents:
      today.stalled || stalled ? null : (today.total_interest_cents as number) - (interest + fee),
  };
}
