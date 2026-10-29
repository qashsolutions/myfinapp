"""Bills & debt (docs/spec.md "Bills & debt", "Calculation rules" Debt avalanche order, "Rules
added for the debt payoff planner").

Debt avalanche order   sort by APR descending, then balance ascending; equal APR and balance →
                       by label. The first debt is where extra payments go. Nothing is moved.
"""

from __future__ import annotations

from . import money
from .dates import add_months, parse_date
from .errors import RuleError
from .money import _int


def _debt(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_debt")
    debt_id = raw.get("id")
    label = raw.get("label")
    if not isinstance(debt_id, str) or not debt_id or not isinstance(label, str):
        raise RuleError("invalid_debt")
    balance = _int(raw.get("balance_cents"))
    apr = _int(raw.get("apr_bps"))
    minimum = _int(raw.get("min_payment_cents"))
    if balance < 0 or apr < 0 or minimum < 0:
        raise RuleError("invalid_amount")
    return {
        "id": debt_id,
        "label": label,
        "balance_cents": balance,
        "apr_bps": apr,
        "min_payment_cents": minimum,
    }


def avalanche_order(debts: object) -> dict:
    if not isinstance(debts, list):
        raise RuleError("invalid_debts")
    rows = [_debt(d) for d in debts]
    rows.sort(key=lambda d: (-d["apr_bps"], d["balance_cents"], d["label"], d["id"]))
    return {
        "order": [{**d, "rank": i + 1} for i, d in enumerate(rows)],
        "total_balance_cents": sum(d["balance_cents"] for d in rows),
        "total_min_payment_cents": sum(d["min_payment_cents"] for d in rows),
        "max_apr_bps": max((d["apr_bps"] for d in rows), default=None),
    }


MAX_MONTHS = 600  # fifty years: past this the plan is not a plan


def _month_label(as_of: str, months_ahead: int) -> str:
    first = parse_date(as_of).replace(day=1)
    return add_months(first, months_ahead).isoformat()[:7]  # strftime skips the zero pad on glibc


ORDERS = ("avalanche", "snowball")


def snowball_order(debts: object) -> list[dict]:
    """Smallest balance first; equal balances → APR descending, then label, then id."""
    if not isinstance(debts, list):
        raise RuleError("invalid_debts")
    rows = [_debt(d) for d in debts]
    rows.sort(key=lambda d: (d["balance_cents"], -d["apr_bps"], d["label"], d["id"]))
    return [{**d, "rank": i + 1} for i, d in enumerate(rows)]


def payoff_plan(debts: object, extra_cents: object, as_of: str, order: object = None) -> dict:
    """The plan month by month (docs/spec.md "Rules added for the debt payoff planner").

    Each month every debt accrues round_div(balance × apr_bps, 120000) in interest, pays its
    minimum, and the rest of a fixed monthly budget (every minimum plus `extra_cents`, so a
    paid-off debt's minimum rolls on) goes to the first debt in the order, spilling to the next.
    `order` is "avalanche" (highest APR first; the default, also for null) or "snowball"
    (smallest starting balance first; the order is fixed at the start).
    """
    parse_date(as_of)  # invalid_date for a bad as_of
    extra = _int(extra_cents, "invalid_amount")
    if extra < 0:
        raise RuleError("invalid_amount")
    kind = "avalanche" if order is None else order
    if kind not in ORDERS:
        raise RuleError("invalid_order")
    order = avalanche_order(debts)["order"] if kind == "avalanche" else snowball_order(debts)
    budget = sum(d["min_payment_cents"] for d in order) + extra
    balances = {d["id"]: d["balance_cents"] for d in order}
    interest = dict.fromkeys(balances, 0)
    paid_month: dict[str, int] = {d["id"]: 0 for d in order if d["balance_cents"] == 0}
    series: list[int] = []
    month = 0
    while len(paid_month) < len(order):
        month += 1
        if month > MAX_MONTHS:
            return {
                "stalled": True,
                "months": None,
                "debt_free_month": None,
                "monthly_budget_cents": budget,
                "total_interest_cents": None,
                "total_paid_cents": None,
                "series_cents": [],
                "order": [
                    {
                        "id": d["id"],
                        "label": d["label"],
                        "rank": d["rank"],
                        "payoff_month": None,
                        "months": None,
                        "interest_cents": None,
                    }
                    for d in order
                ],
            }
        remaining = budget
        for d in order:
            if d["id"] in paid_month:
                continue
            accrued = money.round_div(balances[d["id"]] * d["apr_bps"], 120000)
            interest[d["id"]] += accrued
            balances[d["id"]] += accrued
            payment = min(d["min_payment_cents"], balances[d["id"]], remaining)
            balances[d["id"]] -= payment
            remaining -= payment
        for d in order:  # the first in the order first, the budget's remainder spills down
            if d["id"] in paid_month or remaining <= 0:
                continue
            payment = min(balances[d["id"]], remaining)
            balances[d["id"]] -= payment
            remaining -= payment
        for d in order:
            if d["id"] not in paid_month and balances[d["id"]] == 0:
                paid_month[d["id"]] = month
        series.append(sum(balances.values()))
    total_interest = sum(interest.values())
    return {
        "stalled": False,
        "months": month,
        "debt_free_month": _month_label(as_of, month) if order else None,
        "monthly_budget_cents": budget,
        "total_interest_cents": total_interest,
        "total_paid_cents": sum(d["balance_cents"] for d in order) + total_interest,
        "series_cents": series,
        "order": [
            {
                "id": d["id"],
                "label": d["label"],
                "rank": d["rank"],
                "payoff_month": _month_label(as_of, paid_month[d["id"]]),
                "months": paid_month[d["id"]],
                "interest_cents": interest[d["id"]],
            }
            for d in order
        ],
    }


def consolidation(debts: object, offer: object, payment_cents: object, as_of: str) -> dict:
    """What moving these balances to one new rate would do (fast-follow 8; an illustration).

    Today: the avalanche at a fixed payment (`payoff_plan` with extra = payment − minimums).
    Consolidated: one balance = total + the transfer fee, interest at the intro APR for the
    first `promo_months` and the offer APR after, the same payment each month. No product
    names, no recommendation: the user compares the two and decides.
    """
    payment = _int(payment_cents, "invalid_amount")
    if not isinstance(offer, dict):
        raise RuleError("invalid_offer")
    apr = _int(offer.get("apr_bps"), "invalid_offer")
    fee_bps = _int(offer.get("fee_bps"), "invalid_offer")
    promo_months = _int(offer.get("promo_months"), "invalid_offer")
    promo_apr = _int(offer.get("promo_apr_bps"), "invalid_offer")
    if min(apr, fee_bps, promo_months, promo_apr) < 0:
        raise RuleError("invalid_offer")
    order = avalanche_order(debts)["order"]
    minimums = sum(d["min_payment_cents"] for d in order)
    if payment < minimums:
        raise RuleError("payment_below_minimums")
    today = payoff_plan(debts, payment - minimums, as_of)
    total = sum(d["balance_cents"] for d in order)
    fee = money.round_div(total * fee_bps, 10000)
    balance = total + fee
    interest = 0
    month = 0
    after_promo: int | None = None if promo_months == 0 else None
    stalled = False
    while balance > 0:
        month += 1
        if month > MAX_MONTHS:
            stalled = True
            break
        rate = promo_apr if month <= promo_months else apr
        accrued = money.round_div(balance * rate, 120000)
        interest += accrued
        balance += accrued
        balance -= min(payment, balance)
        if promo_months and month == promo_months:
            after_promo = balance
    if promo_months and month < promo_months and not stalled:
        after_promo = 0
    consolidated = (
        {
            "stalled": True,
            "months": None,
            "interest_cents": None,
            "fee_cents": fee,
            "cost_cents": None,
            "balance_after_promo_cents": None,
        }
        if stalled
        else {
            "stalled": False,
            "months": month,
            "interest_cents": interest,
            "fee_cents": fee,
            "cost_cents": interest + fee,
            "balance_after_promo_cents": after_promo,
        }
    )
    today_out = {
        "stalled": today["stalled"],
        "months": today["months"],
        "interest_cents": today["total_interest_cents"],
    }
    saves = (
        None if today["stalled"] or stalled else today["total_interest_cents"] - (interest + fee)
    )
    return {"today": today_out, "consolidated": consolidated, "saves_cents": saves}
