"""Name -> rule, JSON object in, JSON object out.

This is the contract the on-device engine (Pyodide or the TypeScript port, chunk 0.6)
implements, and the shape every golden test exercises. Input keys are keyword arguments.
"""

from __future__ import annotations

import functools
from collections.abc import Callable

from . import (
    alerts,
    bills,
    budget,
    cashflow,
    categorize,
    credit,
    dates,
    emergency,
    fingerprint,
    forecast,
    goals,
    goals_custom,
    groups,
    growth,
    household,
    insights,
    money,
    networth,
    next_move,
    notify,
    recurring,
    whatif,
)
from .errors import RuleError

Rule = Callable[..., dict]


def _money_parse_amount(text: str) -> dict:
    return {"cents": money.parse_amount(text)}


def _money_round_div(numerator: int, denominator: int) -> dict:
    return {"cents": money.round_div(money._int(numerator), denominator)}


def _money_pct_of(cents: int, bps: int) -> dict:
    return {"cents": money.pct_of(cents, bps)}


def _money_allocate(
    total_cents: int, weights_bps: list[int], remainder_to: int | None = None
) -> dict:
    return {"parts": money.allocate(total_cents, weights_bps, remainder_to)}


def _money_ratio_bps(part: int, whole: int) -> dict:
    return {"bps": money.ratio_bps(part, whole)}


def _dates_month_bounds(as_of: str) -> dict:
    d = dates.parse_date(as_of)
    start, end = dates.month_bounds(d)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days_in_month": dates.days_in_month(d),
    }


def _dates_add_months(date: str, months: int) -> dict:
    return {"date": dates.add_months(dates.parse_date(date), months).isoformat()}


def _dates_add_days(date: str, days: int) -> dict:
    return {"date": dates.add_days(dates.parse_date(date), days).isoformat()}


def _dates_days_until(as_of: str, date: str) -> dict:
    return {"days": dates.days_until(dates.parse_date(as_of), dates.parse_date(date))}


def _dates_next_paydays(as_of: str, schedule: dict, count: int) -> dict:
    paydays = dates.next_paydays(dates.parse_date(as_of), schedule, count)
    return {"dates": [d.isoformat() for d in paydays]}


def _dates_periods_until(
    as_of: str, deadline: str, cadence: str, schedule: dict | None = None
) -> dict:
    periods = dates.periods_until(
        dates.parse_date(as_of), dates.parse_date(deadline), cadence, schedule
    )
    return {"periods": periods}


def _fingerprint_clean_description(text: str) -> dict:
    return {"text": fingerprint.clean_description(text)}


def _fingerprint_row(account_id: str, date: str, amount_cents: int, description: str) -> dict:
    return {
        "fingerprint": fingerprint.fingerprint(account_id, date, amount_cents, description),
        "clean_description": fingerprint.clean_description(description),
    }


def _categorize_match(description: str, direction: str, user_rules: list, keywords: dict) -> dict:
    return categorize.match(description, direction, user_rules, keywords)


def _insights_safe_to_spend(days: list, buffer_cents: int, as_of: str, until: str) -> dict:
    return insights.safe_to_spend(days, buffer_cents, as_of, until)


def _insights_vs_usual(as_of: str, entries: list, thresholds: dict, months: int) -> dict:
    return insights.vs_usual(as_of, entries, thresholds, months)


def _insights_lumpy_bills(as_of: str, series: list, thresholds: dict, months: int) -> dict:
    return insights.lumpy_bills(as_of, series, thresholds, months)


def _insights_top_spending(start: str, end: str, entries: list, limit: int) -> dict:
    return insights.top_spending(start, end, entries, limit)


def _insights_seasonal(as_of: str, entries: list, thresholds: dict) -> dict:
    return insights.seasonal(as_of, entries, thresholds)


def _insights_one_change(candidates: list, order: list) -> dict:
    return insights.one_change(candidates, order)


def _bills_consolidation(debts: list, offer: dict, payment_cents: int, as_of: str) -> dict:
    return bills.consolidation(debts, offer, payment_cents, as_of)


def _cashflow_month_totals(as_of: str, entries: list) -> dict:
    return cashflow.month_totals(as_of, entries)


def _cashflow_period_totals(start: str, end: str, entries: list) -> dict:
    return cashflow.period_totals(start, end, entries)


def _cashflow_series(start: str, end: str, step: str, entries: list) -> dict:
    return cashflow.series(start, end, step, entries)


def _cashflow_fixed_flexible(start: str, end: str, entries: list) -> dict:
    return cashflow.fixed_flexible(start, end, entries)


def _cashflow_net_change(net_cents: int, previous_net_cents: int) -> dict:
    return {"delta_cents": cashflow.net_change(net_cents, previous_net_cents)}


def _cashflow_match_transfers(entries: list, window_days: int | None = None) -> dict:
    # null and left out both mean the default, as every other optional input (the device's
    # registry reads `window_days ?? 5`).
    if window_days is None:
        window_days = 5
    return {"pairs": cashflow.match_transfers(entries, window_days)}


def _budget_targets(take_home_cents: int) -> dict:
    return budget.targets_50_30_20(take_home_cents)


def _budget_monthly_take_home(amount_cents: int, frequency: str) -> dict:
    return {"cents": budget.monthly_take_home(amount_cents, frequency)}


def _budget_targets_split(take_home_cents: int, split_bps: dict) -> dict:
    return budget.targets_split(take_home_cents, split_bps)


def _budget_summary(
    as_of: str,
    method: str,
    take_home_cents: int,
    lines: list,
    entries: list,
    split_bps: dict | None = None,
) -> dict:
    return budget.summary(as_of, method, take_home_cents, lines, entries, split_bps)


def _budget_pace(month: str, as_of: str, lines: list, levels_bps: list) -> dict:
    return budget.pace(month, as_of, lines, levels_bps)


def _goals_progress(goal: dict, events: list, as_of: str) -> dict:
    return goals.progress(goal, events, as_of)


def _goals_spend_less_baseline(estimate_cents: int, previous_months_cents: list) -> dict:
    return {"baseline_cents": goals.spend_less_baseline(estimate_cents, previous_months_cents)}


def _goals_custom_jar(name: str, target_cents: int, end_date: str | None, as_of: str) -> dict:
    return goals_custom.jar(name, target_cents, end_date, as_of)


def _goals_custom_plan(goal: dict, events: list, as_of: str, schedule: object = None) -> dict:
    return goals_custom.plan(goal, events, as_of, schedule)


def _goals_custom_streak(goal: dict, events: list, as_of: str, schedule: object = None) -> dict:
    return goals_custom.streak(goal, events, as_of, schedule)


def _goals_custom_milestones(target_cents: int, current_cents: int, checkpoints_bps: list) -> dict:
    return goals_custom.milestones(target_cents, current_cents, checkpoints_bps)


def _groups_rank(members: list) -> dict:
    return groups.rank(members)


def _household_split_contributions(events: list, members: list) -> dict:
    return household.split_contributions(events, members)


def _household_combine_totals(summaries: list) -> dict:
    return household.combine_totals(summaries)


def _recurring_detect(entries: list, as_of: str) -> dict:
    return recurring.detect(entries, as_of)


def _recurring_yearly_cost(series: list) -> dict:
    return recurring.yearly_cost(series)


def _recurring_subscription_check(
    as_of: str, subscriptions: list, kinds: list, thresholds: dict
) -> dict:
    return recurring.subscription_check(as_of, subscriptions, kinds, thresholds)


def _next_move_pick(facts: dict, config: dict, as_of: str) -> dict:
    return next_move.pick(facts, config, as_of)


def _networth_history(dates: list, accounts: list, items: list) -> dict:
    return networth.history(dates, accounts, items)


def _networth_summary(items: list, previous_net_cents: int | None) -> dict:
    return networth.summary(items, previous_net_cents)


def _emergency_summary(
    saved_cents: int, essentials_cents: int, target_months: int, monthly_plan_cents: int
) -> dict:
    return emergency.summary(saved_cents, essentials_cents, target_months, monthly_plan_cents)


def _credit_utilization_bps(
    statement_balance_cents: int | None, current_balance_cents: int | None, limit_cents: int | None
) -> dict:
    return credit.utilization_bps(statement_balance_cents, current_balance_cents, limit_cents)


def _credit_pay_in_full(
    as_of: str,
    statement_balance_cents: int,
    statement_date: str | None,
    last_payment_cents: int | None,
    last_payment_date: str | None,
    due_date: str | None,
    paydays: list,
) -> dict:
    return credit.pay_in_full(
        as_of,
        statement_balance_cents,
        statement_date,
        last_payment_cents,
        last_payment_date,
        due_date,
        paydays,
    )


def _credit_card_trend(entries: list, as_of: str, months: int) -> dict:
    return credit.card_trend(entries, as_of, months)


def _credit_habits(
    due_dates: list,
    payments: list,
    as_of: str,
    months: int,
    guide_bps: int,
    due_day: int | None = None,
    minimum_cents: int | None = None,
    statements: list | None = None,
    statement_balance_cents: int | None = None,
    current_balance_cents: int | None = None,
    limit_cents: int | None = None,
    since: str | None = None,
    balance_history: dict | None = None,
    until: str | None = None,
) -> dict:
    return credit.habits(
        due_dates,
        due_day,
        payments,
        minimum_cents,
        statements,
        statement_balance_cents,
        current_balance_cents,
        limit_cents,
        as_of,
        months,
        guide_bps,
        since,
        balance_history,
        until,
    )


def _bills_avalanche_order(debts: list) -> dict:
    return bills.avalanche_order(debts)


def _bills_payoff_plan(debts: list, extra_cents: int, as_of: str, order: str | None = None) -> dict:
    return bills.payoff_plan(debts, extra_cents, as_of, order)


def _growth_projection(
    age_now: int,
    retire_age: int,
    start_cents: int,
    monthly_cents: int,
    rates_bps: list,
    target_cents: int,
) -> dict:
    return growth.projection(
        age_now, retire_age, start_cents, monthly_cents, rates_bps, target_cents
    )


def _growth_goal_plan(
    today_cost_cents: int,
    cost_rise_bps: int,
    return_bps: int,
    saved_cents: int,
    as_of: str,
    target_date: str,
    priced_on: str | None = None,
) -> dict:
    return growth.goal_plan(
        today_cost_cents, cost_rise_bps, return_bps, saved_cents, as_of, target_date, priced_on
    )


def _growth_goal_reach(
    today_cost_cents: int,
    cost_rise_bps: int,
    return_bps: int,
    saved_cents: int,
    monthly_cents: int,
    as_of: str,
    target_date: str,
    priced_on: str | None = None,
) -> dict:
    return growth.goal_reach(
        today_cost_cents,
        cost_rise_bps,
        return_bps,
        saved_cents,
        monthly_cents,
        as_of,
        target_date,
        priced_on,
    )


def _growth_goal_pace(
    plan_monthly_cents: int, deposited_cents: int, start_date: str, as_of: str
) -> dict:
    return growth.goal_pace(plan_monthly_cents, deposited_cents, start_date, as_of)


def _whatif_debt(
    debts: list, extra_cents: int, add_cents: int, as_of: str, order: str | None = None
) -> dict:
    return whatif.debt(debts, extra_cents, add_cents, as_of, order)


def _whatif_goal(remaining_cents: int, per_month_cents: int, add_cents: int, as_of: str) -> dict:
    return whatif.goal(remaining_cents, per_month_cents, add_cents, as_of)


def _notify_decide(
    candidate: dict, settings: dict, prefs: dict, sent: dict, now_local: str
) -> dict:
    return notify.decide(candidate, settings, prefs, sent, now_local)


def _alerts_schedule(inputs: dict) -> dict:
    return alerts.schedule(inputs)


def _alerts_tag(value: str, salt: str) -> dict:
    return {"tag": alerts.tag(value, salt)}


def _next_move_set_aside(
    deposits: list, as_of: str, target_cents: int | None, paydays: list
) -> dict:
    return next_move.set_aside(deposits, as_of, target_cents, paydays)


def _next_move_payday_nudge(
    paycheck_cents: int, target_cents: int | None, monthly_take_home_cents: int, share_bps: int
) -> dict:
    return {
        "cents": next_move.payday_nudge(
            paycheck_cents, target_cents, monthly_take_home_cents, share_bps
        )
    }


def _forecast_typical_daily_spending(
    entries: list, as_of: str, fallback_monthly_cents: int
) -> dict:
    return forecast.typical_daily_spending(entries, as_of, fallback_monthly_cents)


def _forecast_start_balance(anchor: dict | None, entries: list) -> dict:
    return forecast.start_balance(anchor, entries)


def _forecast_upcoming(series: list, entries: list, as_of: str, days: int) -> dict:
    return forecast.upcoming(series, entries, as_of, days)


def _forecast_project(
    as_of: str,
    start_balance_cents: int,
    daily_cents: int,
    upcoming: list,
    buffer_cents: int,
    days: int,
) -> dict:
    return forecast.project(as_of, start_balance_cents, daily_cents, upcoming, buffer_cents, days)


_BARE: dict[str, Rule] = {
    "money.parse_amount": _money_parse_amount,
    "money.round_div": _money_round_div,
    "money.pct_of": _money_pct_of,
    "money.allocate": _money_allocate,
    "money.ratio_bps": _money_ratio_bps,
    "dates.month_bounds": _dates_month_bounds,
    "dates.add_months": _dates_add_months,
    "dates.add_days": _dates_add_days,
    "dates.days_until": _dates_days_until,
    "dates.next_paydays": _dates_next_paydays,
    "dates.periods_until": _dates_periods_until,
    "fingerprint.clean_description": _fingerprint_clean_description,
    "fingerprint.row": _fingerprint_row,
    "categorize.match": _categorize_match,
    "insights.safe_to_spend": _insights_safe_to_spend,
    "insights.vs_usual": _insights_vs_usual,
    "insights.lumpy_bills": _insights_lumpy_bills,
    "insights.seasonal": _insights_seasonal,
    "insights.top_spending": _insights_top_spending,
    "insights.one_change": _insights_one_change,
    "bills.consolidation": _bills_consolidation,
    "cashflow.month_totals": _cashflow_month_totals,
    "cashflow.period_totals": _cashflow_period_totals,
    "cashflow.series": _cashflow_series,
    "cashflow.fixed_flexible": _cashflow_fixed_flexible,
    "cashflow.net_change": _cashflow_net_change,
    "cashflow.match_transfers": _cashflow_match_transfers,
    "budget.targets_50_30_20": _budget_targets,
    "budget.targets_split": _budget_targets_split,
    "budget.monthly_take_home": _budget_monthly_take_home,
    "budget.summary": _budget_summary,
    "budget.pace": _budget_pace,
    "goals.progress": _goals_progress,
    "goals.spend_less_baseline": _goals_spend_less_baseline,
    "goals_custom.jar": _goals_custom_jar,
    "goals_custom.plan": _goals_custom_plan,
    "goals_custom.streak": _goals_custom_streak,
    "goals_custom.milestones": _goals_custom_milestones,
    "groups.rank": _groups_rank,
    "household.split_contributions": _household_split_contributions,
    "household.combine_totals": _household_combine_totals,
    "recurring.detect": _recurring_detect,
    "recurring.yearly_cost": _recurring_yearly_cost,
    "recurring.subscription_check": _recurring_subscription_check,
    "next_move.pick": _next_move_pick,
    "emergency.summary": _emergency_summary,
    "networth.history": _networth_history,
    "networth.summary": _networth_summary,
    "bills.avalanche_order": _bills_avalanche_order,
    "bills.payoff_plan": _bills_payoff_plan,
    "credit.utilization_bps": _credit_utilization_bps,
    "credit.pay_in_full": _credit_pay_in_full,
    "credit.card_trend": _credit_card_trend,
    "credit.habits": _credit_habits,
    "growth.projection": _growth_projection,
    "growth.goal_plan": _growth_goal_plan,
    "growth.goal_reach": _growth_goal_reach,
    "growth.goal_pace": _growth_goal_pace,
    "whatif.debt": _whatif_debt,
    "whatif.goal": _whatif_goal,
    "notify.decide": _notify_decide,
    "alerts.schedule": _alerts_schedule,
    "alerts.tag": _alerts_tag,
    "next_move.set_aside": _next_move_set_aside,
    "next_move.payday_nudge": _next_move_payday_nudge,
    "forecast.typical_daily_spending": _forecast_typical_daily_spending,
    "forecast.start_balance": _forecast_start_balance,
    "forecast.upcoming": _forecast_upcoming,
    "forecast.project": _forecast_project,
}


def _guarded(fn: Rule) -> Rule:
    """Every rule's two boundary checks, the same in both registries: a date pushed past the
    calendar (year 1 to 9999) is `invalid_date`, never Python's OverflowError, and an output
    integer past 2^53 - 1 is `too_large`, since the device could not hold it exactly."""

    @functools.wraps(fn)
    def run(**kwargs: object) -> dict:
        try:
            out = fn(**kwargs)
        except OverflowError as exc:
            raise RuleError("invalid_date") from exc
        money.check_output(out)
        return out

    return run


RULES: dict[str, Rule] = {name: _guarded(fn) for name, fn in _BARE.items()}
