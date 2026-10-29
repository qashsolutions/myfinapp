"""What if (docs/spec.md "What if", "Calculation rules" whatif.debt and whatif.goal; October 28,
2026). One lever moved, the same plan run twice: before and after. An illustration from the
person's own numbers, never advice.
"""

from __future__ import annotations

from . import bills
from .dates import add_months, parse_date
from .errors import RuleError
from .money import _int

MAX_MONTHS = 1200  # a hundred years: a jar further out than this has no date at that pace


def _side(plan: dict) -> dict:
    return {
        "months": plan["months"],
        "debt_free_month": plan["debt_free_month"],
        "interest_cents": plan["total_interest_cents"],
    }


def debt(
    debts: object, extra_cents: object, add_cents: object, as_of: str, order: object = None
) -> dict:
    """bills.payoff_plan with today's extra, then with `add_cents` more each month, both in the
    person's `order` (null = avalanche, as the payoff plan)."""
    add = _int(add_cents, "invalid_amount")
    if add < 0:
        raise RuleError("invalid_amount")
    before = bills.payoff_plan(debts, extra_cents, as_of, order)
    after = bills.payoff_plan(debts, _int(extra_cents, "invalid_amount") + add, as_of, order)
    both = not before["stalled"] and not after["stalled"]
    if after["stalled"]:
        status = "stalled"
    elif before["stalled"] or after["months"] < before["months"]:
        status = "sooner"
    else:
        status = "same"
    return {
        "before": _side(before),
        "after": _side(after),
        "months_sooner": before["months"] - after["months"] if both else None,
        "interest_saved_cents": (
            before["total_interest_cents"] - after["total_interest_cents"] if both else None
        ),
        "status": status,
    }


def _months_to(remaining: int, per_month: int) -> int | None:
    if remaining == 0:
        return 0
    if per_month == 0:
        return None
    months = -(-remaining // per_month)  # ceiling
    return months if months <= MAX_MONTHS else None


def _finish(as_of: str, months: int | None) -> str | None:
    if months is None:
        return None
    first = parse_date(as_of).replace(day=1)
    return add_months(first, months).isoformat()[:7]


def goal(remaining_cents: object, per_month_cents: object, add_cents: object, as_of: str) -> dict:
    """Months to fill a jar at today's pace and with `add_cents` more a month."""
    parse_date(as_of)
    remaining = _int(remaining_cents, "invalid_amount")
    per_month = _int(per_month_cents, "invalid_amount")
    add = _int(add_cents, "invalid_amount")
    if remaining < 0 or per_month < 0 or add < 0:
        raise RuleError("invalid_amount")
    now = _months_to(remaining, per_month)
    new = _months_to(remaining, per_month + add)
    if new is None:
        status = "never"
    elif now is None or new < now:
        status = "sooner"
    else:
        status = "same"
    return {
        "months_now": now,
        "months_new": new,
        "finish_now": _finish(as_of, now),
        "finish_new": _finish(as_of, new),
        "months_sooner": now - new if now is not None and new is not None else None,
        "status": status,
    }
