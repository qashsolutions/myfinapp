/**
 * Port of stackd_rules/registry.py: "<module>.<rule>" -> JSON object in, JSON object out.
 * Keys and shapes must match the Python registry exactly; golden.test.ts enforces it.
 */

import * as alerts from "./alerts.ts";
import * as bills from "./bills.ts";
import * as budget from "./budget.ts";
import * as cashflow from "./cashflow.ts";
import * as categorize from "./categorize.ts";
import * as credit from "./credit.ts";
import * as dates from "./dates.ts";
import * as emergency from "./emergency.ts";
import * as fingerprint from "./fingerprint.ts";
import * as forecast from "./forecast.ts";
import * as goals from "./goals.ts";
import * as goalsCustom from "./goals_custom.ts";
import * as groups from "./groups.ts";
import * as growth from "./growth.ts";
import * as household from "./household.ts";
import * as insights from "./insights.ts";
import * as money from "./money.ts";
import * as networth from "./networth.ts";
import * as nextMove from "./next_move.ts";
import * as notify from "./notify.ts";
import * as recurring from "./recurring.ts";
import * as whatif from "./whatif.ts";

export type JsonObject = Record<string, unknown>;
export type Rule = (input: JsonObject) => JsonObject;

/** Mirror Python's fn(**input): unknown or missing keys are programming errors, not RuleErrors. */
function args(input: JsonObject, required: string[], optional: string[] = []): JsonObject {
  for (const key of required) {
    if (!(key in input)) throw new TypeError(`missing required argument: ${key}`);
  }
  for (const key of Object.keys(input)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new TypeError(`unexpected argument: ${key}`);
    }
  }
  return input;
}

const BARE: Record<string, Rule> = {
  "money.parse_amount": (input) => {
    const { text } = args(input, ["text"]);
    return { cents: money.parseAmount(text) };
  },
  "money.round_div": (input) => {
    const { numerator, denominator } = args(input, ["numerator", "denominator"]);
    return { cents: money.roundDiv(numerator, denominator) };
  },
  "money.pct_of": (input) => {
    const { cents, bps } = args(input, ["cents", "bps"]);
    return { cents: money.pctOf(cents, bps) };
  },
  "money.allocate": (input) => {
    const { total_cents, weights_bps, remainder_to } = args(
      input,
      ["total_cents", "weights_bps"],
      ["remainder_to"],
    );
    return { parts: money.allocate(total_cents, weights_bps, remainder_to ?? null) };
  },
  "money.ratio_bps": (input) => {
    const { part, whole } = args(input, ["part", "whole"]);
    return { bps: money.ratioBps(part, whole) };
  },
  "dates.month_bounds": (input) => {
    const { as_of } = args(input, ["as_of"]);
    const d = dates.parseDate(as_of);
    const [start, end] = dates.monthBounds(d);
    return { start: dates.iso(start), end: dates.iso(end), days_in_month: dates.daysInMonth(d) };
  },
  "dates.add_months": (input) => {
    const { date, months } = args(input, ["date", "months"]);
    return { date: dates.iso(dates.addMonths(dates.parseDate(date), months)) };
  },
  "dates.add_days": (input) => {
    const { date, days } = args(input, ["date", "days"]);
    return { date: dates.iso(dates.addDays(dates.parseDate(date), money.assertInt(days))) };
  },
  "dates.days_until": (input) => {
    const { as_of, date } = args(input, ["as_of", "date"]);
    return { days: dates.daysUntil(dates.parseDate(as_of), dates.parseDate(date)) };
  },
  "dates.next_paydays": (input) => {
    const { as_of, schedule, count } = args(input, ["as_of", "schedule", "count"]);
    return { dates: dates.nextPaydays(dates.parseDate(as_of), schedule, count).map(dates.iso) };
  },
  "dates.periods_until": (input) => {
    const { as_of, deadline, cadence, schedule } = args(
      input,
      ["as_of", "deadline", "cadence"],
      ["schedule"],
    );
    return {
      periods: dates.periodsUntil(
        dates.parseDate(as_of),
        dates.parseDate(deadline),
        cadence,
        schedule ?? null,
      ),
    };
  },
  "fingerprint.clean_description": (input) => {
    const { text } = args(input, ["text"]);
    return { text: fingerprint.cleanDescription(text) };
  },
  "fingerprint.row": (input) => {
    const { account_id, date, amount_cents, description } = args(input, [
      "account_id",
      "date",
      "amount_cents",
      "description",
    ]);
    return {
      fingerprint: fingerprint.fingerprint(account_id, date, amount_cents, description),
      clean_description: fingerprint.cleanDescription(description),
    };
  },
  "categorize.match": (input) => {
    const { description, direction, user_rules, keywords } = args(input, [
      "description",
      "direction",
      "user_rules",
      "keywords",
    ]);
    return { ...categorize.match(description, direction, user_rules, keywords) };
  },
  "insights.safe_to_spend": (input) => {
    const { days, buffer_cents, as_of, until } = args(input, [
      "days",
      "buffer_cents",
      "as_of",
      "until",
    ]);
    return { ...insights.safeToSpend(days, buffer_cents, as_of, until) };
  },
  "insights.vs_usual": (input) => {
    const { as_of, entries, thresholds, months } = args(input, [
      "as_of",
      "entries",
      "thresholds",
      "months",
    ]);
    return { ...insights.vsUsual(as_of, entries, thresholds, months) };
  },
  "insights.lumpy_bills": (input) => {
    const { as_of, series, thresholds, months } = args(input, [
      "as_of",
      "series",
      "thresholds",
      "months",
    ]);
    return { ...insights.lumpyBills(as_of, series, thresholds, months) };
  },
  "insights.seasonal": (input) => {
    const { as_of, entries, thresholds } = args(input, ["as_of", "entries", "thresholds"]);
    return { ...insights.seasonal(as_of, entries, thresholds) };
  },
  "insights.top_spending": (input) => {
    const { start, end, entries, limit } = args(input, ["start", "end", "entries", "limit"]);
    return { ...insights.topSpending(start, end, entries, limit) };
  },
  "bills.consolidation": (input) => {
    const { debts, offer, payment_cents, as_of } = args(input, [
      "debts",
      "offer",
      "payment_cents",
      "as_of",
    ]);
    return { ...bills.consolidation(debts, offer, payment_cents, as_of) };
  },
  "cashflow.month_totals": (input) => {
    const { as_of, entries } = args(input, ["as_of", "entries"]);
    return { ...cashflow.monthTotals(as_of, entries) };
  },
  "cashflow.period_totals": (input) => {
    const { start, end, entries } = args(input, ["start", "end", "entries"]);
    return { ...cashflow.periodTotals(start, end, entries) };
  },
  "cashflow.series": (input) => {
    const { start, end, step, entries } = args(input, ["start", "end", "step", "entries"]);
    return { ...cashflow.series(start, end, step, entries) };
  },
  "cashflow.fixed_flexible": (input) => {
    const { start, end, entries } = args(input, ["start", "end", "entries"]);
    return { ...cashflow.fixedFlexible(start, end, entries) };
  },
  "cashflow.net_change": (input) => {
    const { net_cents, previous_net_cents } = args(input, ["net_cents", "previous_net_cents"]);
    return { delta_cents: cashflow.netChange(net_cents, previous_net_cents) };
  },
  "cashflow.match_transfers": (input) => {
    const { entries, window_days } = args(input, ["entries"], ["window_days"]);
    return { pairs: cashflow.matchTransfers(entries, window_days ?? 5) };
  },
  "budget.targets_50_30_20": (input) => {
    const { take_home_cents } = args(input, ["take_home_cents"]);
    return { ...budget.targets503020(take_home_cents) };
  },
  "budget.targets_split": (input) => {
    const { take_home_cents, split_bps } = args(input, ["take_home_cents", "split_bps"]);
    return { ...budget.targetsSplit(take_home_cents, split_bps) };
  },
  "budget.monthly_take_home": (input) => {
    const { amount_cents, frequency } = args(input, ["amount_cents", "frequency"]);
    return { cents: budget.monthlyTakeHome(amount_cents, frequency) };
  },
  "budget.summary": (input) => {
    const { as_of, method, take_home_cents, lines, entries, split_bps } = args(
      input,
      ["as_of", "method", "take_home_cents", "lines", "entries"],
      ["split_bps"],
    );
    return {
      ...budget.summary(as_of, method, take_home_cents, lines, entries, split_bps ?? null),
    };
  },
  "goals.progress": (input) => {
    const { goal, events, as_of } = args(input, ["goal", "events", "as_of"]);
    return { ...goals.progress(goal, events, as_of) };
  },
  "goals.spend_less_baseline": (input) => {
    const { estimate_cents, previous_months_cents } = args(input, [
      "estimate_cents",
      "previous_months_cents",
    ]);
    return { baseline_cents: goals.spendLessBaseline(estimate_cents, previous_months_cents) };
  },
  "goals_custom.jar": (input) => {
    const { name, target_cents, end_date, as_of } = args(input, [
      "name",
      "target_cents",
      "end_date",
      "as_of",
    ]);
    return { ...goalsCustom.jar(name, target_cents, end_date, as_of) };
  },
  "goals_custom.plan": (input) => {
    const { goal, events, as_of, schedule } = args(
      input,
      ["goal", "events", "as_of"],
      ["schedule"],
    );
    return { ...goalsCustom.plan(goal, events, as_of, schedule ?? null) };
  },
  "goals_custom.streak": (input) => {
    const { goal, events, as_of, schedule } = args(
      input,
      ["goal", "events", "as_of"],
      ["schedule"],
    );
    return { ...goalsCustom.streak(goal, events, as_of, schedule ?? null) };
  },
  "goals_custom.milestones": (input) => {
    const { target_cents, current_cents, checkpoints_bps } = args(input, [
      "target_cents",
      "current_cents",
      "checkpoints_bps",
    ]);
    return { ...goalsCustom.milestones(target_cents, current_cents, checkpoints_bps) };
  },
  "groups.rank": (input) => {
    const { members } = args(input, ["members"]);
    return { ...groups.rank(members) };
  },
  "household.split_contributions": (input) => {
    const { events, members } = args(input, ["events", "members"]);
    return { ...household.splitContributions(events, members) };
  },
  "household.combine_totals": (input) => {
    const { summaries } = args(input, ["summaries"]);
    return { ...household.combineTotals(summaries) };
  },
  "networth.history": (input) => {
    const { dates, accounts, items } = args(input, ["dates", "accounts", "items"]);
    return { ...networth.history(dates, accounts, items) };
  },
  "networth.summary": (input) => {
    const { items, previous_net_cents } = args(input, ["items", "previous_net_cents"]);
    return { ...networth.summary(items, previous_net_cents) };
  },
  "emergency.summary": (input) => {
    const { saved_cents, essentials_cents, target_months, monthly_plan_cents } = args(input, [
      "saved_cents",
      "essentials_cents",
      "target_months",
      "monthly_plan_cents",
    ]);
    return {
      ...emergency.summary(saved_cents, essentials_cents, target_months, monthly_plan_cents),
    };
  },
  "credit.utilization_bps": (input) => {
    const { statement_balance_cents, current_balance_cents, limit_cents } = args(input, [
      "statement_balance_cents",
      "current_balance_cents",
      "limit_cents",
    ]);
    return {
      ...credit.utilizationBps(statement_balance_cents, current_balance_cents, limit_cents),
    };
  },
  "credit.pay_in_full": (input) => {
    const a = args(input, [
      "as_of",
      "statement_balance_cents",
      "statement_date",
      "last_payment_cents",
      "last_payment_date",
      "due_date",
      "paydays",
    ]);
    return {
      ...credit.payInFull(
        a.as_of,
        a.statement_balance_cents,
        a.statement_date,
        a.last_payment_cents,
        a.last_payment_date,
        a.due_date,
        a.paydays,
      ),
    };
  },
  "credit.card_trend": (input) => {
    const { entries, as_of, months } = args(input, ["entries", "as_of", "months"]);
    return { ...credit.cardTrend(entries, as_of, months) };
  },
  "credit.habits": (input) => {
    const a = args(
      input,
      ["due_dates", "payments", "as_of", "months", "guide_bps"],
      [
        "due_day",
        "minimum_cents",
        "statements",
        "statement_balance_cents",
        "current_balance_cents",
        "limit_cents",
        "since",
        "balance_history",
      ],
    );
    return {
      ...credit.habits(
        a.due_dates,
        a.due_day ?? null,
        a.payments,
        a.minimum_cents ?? null,
        a.statements ?? null,
        a.statement_balance_cents ?? null,
        a.current_balance_cents ?? null,
        a.limit_cents ?? null,
        a.as_of,
        a.months,
        a.guide_bps,
        a.since ?? null,
        a.balance_history ?? null,
      ),
    };
  },
  "bills.avalanche_order": (input) => {
    const { debts } = args(input, ["debts"]);
    return { ...bills.avalancheOrder(debts) };
  },
  "bills.payoff_plan": (input) => {
    const { debts, extra_cents, as_of, order } = args(
      input,
      ["debts", "extra_cents", "as_of"],
      ["order"],
    );
    return { ...bills.payoffPlan(debts, extra_cents, as_of, order) };
  },
  "growth.projection": (input) => {
    const { age_now, retire_age, start_cents, monthly_cents, rates_bps, target_cents } = args(
      input,
      ["age_now", "retire_age", "start_cents", "monthly_cents", "rates_bps", "target_cents"],
    );
    return {
      ...growth.projection(
        age_now,
        retire_age,
        start_cents,
        monthly_cents,
        rates_bps,
        target_cents,
      ),
    };
  },
  "growth.goal_plan": (input) => {
    const a = args(
      input,
      ["today_cost_cents", "cost_rise_bps", "return_bps", "saved_cents", "as_of", "target_date"],
      ["priced_on"],
    );
    return {
      ...growth.goalPlan(
        a.today_cost_cents,
        a.cost_rise_bps,
        a.return_bps,
        a.saved_cents,
        a.as_of,
        a.target_date,
        a.priced_on ?? null,
      ),
    };
  },
  "growth.goal_pace": (input) => {
    const a = args(input, ["plan_monthly_cents", "deposited_cents", "start_date", "as_of"]);
    return {
      ...growth.goalPace(a.plan_monthly_cents, a.deposited_cents, a.start_date, a.as_of),
    };
  },
  "whatif.debt": (input) => {
    const a = args(input, ["debts", "extra_cents", "add_cents", "as_of"]);
    return { ...whatif.debt(a.debts, a.extra_cents, a.add_cents, a.as_of) };
  },
  "whatif.goal": (input) => {
    const a = args(input, ["remaining_cents", "per_month_cents", "add_cents", "as_of"]);
    return { ...whatif.goal(a.remaining_cents, a.per_month_cents, a.add_cents, a.as_of) };
  },
  "notify.decide": (input) => {
    const { candidate, settings, prefs, sent, now_local } = args(input, [
      "candidate",
      "settings",
      "prefs",
      "sent",
      "now_local",
    ]);
    return { ...notify.decide(candidate, settings, prefs, sent, now_local) };
  },
  "alerts.schedule": (input) => {
    const { inputs } = args(input, ["inputs"]);
    return { ...alerts.schedule(inputs) };
  },
  "next_move.pick": (input) => {
    const { facts, config, as_of } = args(input, ["facts", "config", "as_of"]);
    return { ...nextMove.pick(facts, config, as_of) };
  },
  "next_move.set_aside": (input) => {
    const { deposits, as_of, target_cents, paydays } = args(input, [
      "deposits",
      "as_of",
      "target_cents",
      "paydays",
    ]);
    return { ...nextMove.setAside(deposits, as_of, target_cents, paydays) };
  },
  "next_move.payday_nudge": (input) => {
    const { paycheck_cents, target_cents, monthly_take_home_cents, share_bps } = args(input, [
      "paycheck_cents",
      "target_cents",
      "monthly_take_home_cents",
      "share_bps",
    ]);
    return {
      cents: nextMove.paydayNudge(paycheck_cents, target_cents, monthly_take_home_cents, share_bps),
    };
  },
  "recurring.detect": (input) => {
    const { entries, as_of } = args(input, ["entries", "as_of"]);
    return { ...recurring.detect(entries, as_of) };
  },
  "recurring.yearly_cost": (input) => {
    const { series } = args(input, ["series"]);
    return { ...recurring.yearlyCost(series) };
  },
  "recurring.subscription_check": (input) => {
    const { as_of, subscriptions, kinds, thresholds } = args(input, [
      "as_of",
      "subscriptions",
      "kinds",
      "thresholds",
    ]);
    return { ...recurring.subscriptionCheck(as_of, subscriptions, kinds, thresholds) };
  },
  "forecast.typical_daily_spending": (input) => {
    const { entries, as_of, fallback_monthly_cents } = args(input, [
      "entries",
      "as_of",
      "fallback_monthly_cents",
    ]);
    return { ...forecast.typicalDailySpending(entries, as_of, fallback_monthly_cents) };
  },
  "forecast.start_balance": (input) => {
    const { anchor, entries } = args(input, ["anchor", "entries"]);
    return { ...forecast.startBalance(anchor, entries) };
  },
  "forecast.upcoming": (input) => {
    const { series, entries, as_of, days } = args(input, ["series", "entries", "as_of", "days"]);
    return { ...forecast.upcoming(series, entries, as_of, days) };
  },
  "forecast.project": (input) => {
    const { as_of, start_balance_cents, daily_cents, upcoming, buffer_cents, days } = args(input, [
      "as_of",
      "start_balance_cents",
      "daily_cents",
      "upcoming",
      "buffer_cents",
      "days",
    ]);
    return {
      ...forecast.project(as_of, start_balance_cents, daily_cents, upcoming, buffer_cents, days),
    };
  },
};

/**
 * Every rule's output boundary, the same in both registries: an integer past 2^53 − 1 is
 * `too_large` (Python would hold it exactly; this engine would round it).
 */
export const RULES: Record<string, Rule> = Object.fromEntries(
  Object.entries(BARE).map(([name, fn]) => [
    name,
    (input: JsonObject) => {
      const out = fn(input);
      money.checkOutput(out);
      return out;
    },
  ]),
);
