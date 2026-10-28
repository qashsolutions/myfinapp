"""Emergency fund as a jar (docs/spec.md "Emergency fund", "Calculation rules").

Runway   saved ÷ monthly essentials, one decimal (returned in tenths of a month);
         essentials = 0 → hidden (None).
ETA      ceil((target − saved) ÷ monthly plan) months; plan = 0 → None ("set a monthly amount");
         already there → 0.
Milestones  the $1,000 starter fund, one month of essentials, and the target of
            1 to 12 months (the person picks; 3 and 6 are offered).
"""

from __future__ import annotations

from . import money
from .errors import RuleError
from .money import _int

MIN_TARGET_MONTHS, MAX_TARGET_MONTHS = 1, 12
STARTER_CENTS = 100000


def _amount(value: object) -> int:
    cents = _int(value)
    if cents < 0:
        raise RuleError("invalid_amount")
    return cents


def runway_tenths(saved_cents: int, essentials_cents: int) -> int | None:
    saved, essentials = _amount(saved_cents), _amount(essentials_cents)
    if essentials == 0:
        return None
    return money.round_div(saved * 10, essentials)


def eta_months(saved_cents: int, target_cents: int, monthly_plan_cents: int) -> int | None:
    saved, target, plan = _amount(saved_cents), _amount(target_cents), _amount(monthly_plan_cents)
    if target <= saved:
        return 0
    if plan == 0:
        return None
    return -(-(target - saved) // plan)


def summary(
    saved_cents: int, essentials_cents: int, target_months: int, monthly_plan_cents: int
) -> dict:
    saved, essentials, plan = (
        _amount(saved_cents),
        _amount(essentials_cents),
        _amount(monthly_plan_cents),
    )
    months = _int(target_months)
    if not MIN_TARGET_MONTHS <= months <= MAX_TARGET_MONTHS:
        raise RuleError("invalid_target")
    milestones: list[dict] = []

    def milestone(key: str, target: int, **extra: object) -> dict:
        return {
            "key": key,
            "target_cents": target,
            "progress_bps": min(10000, money.ratio_bps(saved, target) or 0),
            "reached": saved >= target,
            "eta_months": eta_months(saved, target, plan),
            **extra,
        }

    milestones.append(milestone("starter", STARTER_CENTS))
    if essentials > 0:
        milestones.append(milestone("one_month", essentials))
        milestones.append(milestone("target", essentials * months, months=months))
    return {
        "saved_cents": saved,
        "essentials_cents": essentials,
        "runway_tenths": runway_tenths(saved, essentials),
        "target_months": months,
        "monthly_plan_cents": plan,
        "milestones": milestones,
    }
