"""Compound growth (docs/spec.md "Learn", "Calculation rules" Compound growth).

FV = P × ((1 + r)^n − 1) ÷ r with r = annual rate ÷ 12 and n = years × 12; r = 0 → P × n.
Computed exactly as a fraction and rounded half-even once, so both engines agree to the cent.
An illustration using the rate the user enters: not a prediction, not advice.
"""

from __future__ import annotations

from fractions import Fraction

from .errors import RuleError
from .money import _int

MAX_YEARS = 50
MAX_RATE_BPS = 50000  # 500% a year is already nonsense; anything above is a typo
MONTHS_BPS = 120000  # 12 months × 10000 bps
# The most cents both engines count exactly (2^53 − 1, JavaScript's largest safe integer): any
# amount in or out above it is `too_large`, so the two engines never differ (October 27, 2026).
MAX_CENTS = 2**53 - 1


def _fits(*cents: int) -> None:
    if any(c > MAX_CENTS for c in cents):
        raise RuleError("too_large")


def compound(monthly_cents: int, years: int, rate_bps: int) -> dict:
    monthly = _int(monthly_cents)
    years_n = _int(years)
    rate = _int(rate_bps)
    if monthly < 0:
        raise RuleError("invalid_amount")
    if not 1 <= years_n <= MAX_YEARS:
        raise RuleError("invalid_years")
    if not 0 <= rate <= MAX_RATE_BPS:
        raise RuleError("invalid_rate")
    _fits(monthly)
    n = years_n * 12
    contributed = monthly * n
    _fits(contributed)
    if rate == 0:
        return {"future_value_cents": contributed, "contributed_cents": contributed, "months": n}
    r = Fraction(rate, MONTHS_BPS)
    fv = Fraction(monthly) * ((1 + r) ** n - 1) / r
    future = round(fv)
    _fits(future)
    return {"future_value_cents": future, "contributed_cents": contributed, "months": n}


MIN_AGE = 16
MAX_AGE = 100
MAX_RATES = 3


def _balance(start: int, monthly: int, r: Fraction, grown: Fraction, months: int) -> Fraction:
    """S × (1 + r)^m + P × ((1 + r)^m − 1) ÷ r, with grown = (1 + r)^m; r = 0 → S + P × m."""
    if r == 0:
        return Fraction(start + monthly * months)
    return start * grown + monthly * (grown - 1) / r


def projection(
    age_now: int,
    retire_age: int,
    start_cents: int,
    monthly_cents: int,
    rates_bps: list,
    target_cents: int,
) -> dict:
    """Long-range projection (docs/spec.md "Calculation rules", October 25, 2026): the person's
    own savings at each whole year from now to the age they retire, at up to three rates they
    set, with whether the middle rate reaches their goal and what a month would reach it.
    An illustration at the rates the person enters: not a prediction, not advice."""
    now = _int(age_now)
    retire = _int(retire_age)
    start = _int(start_cents)
    monthly = _int(monthly_cents)
    target = _int(target_cents)
    if not MIN_AGE <= now < MAX_AGE or not now < retire <= MAX_AGE:
        raise RuleError("invalid_age")
    if start < 0 or monthly < 0 or target < 0:
        raise RuleError("invalid_amount")
    if not isinstance(rates_bps, list) or not 1 <= len(rates_bps) <= MAX_RATES:
        raise RuleError("invalid_rates")
    rates = [_int(r) for r in rates_bps]
    if any(not 0 <= r <= MAX_RATE_BPS for r in rates):
        raise RuleError("invalid_rate")
    if any(b < a for a, b in zip(rates, rates[1:], strict=False)):
        raise RuleError("invalid_rates")
    _fits(start, monthly, target)
    years = retire - now
    monthly_r = [Fraction(rate, MONTHS_BPS) for rate in rates]
    per_year = [(1 + r) ** 12 for r in monthly_r]
    grown = [Fraction(1)] * len(rates)
    points = []
    for k in range(years + 1):
        if k:
            grown = [g * f for g, f in zip(grown, per_year, strict=True)]
        months = 12 * k
        points.append(
            {
                "age": now + k,
                "contributed_cents": start + monthly * months,
                "balances_cents": [
                    round(_balance(start, monthly, r, g, months))
                    for r, g in zip(monthly_r, grown, strict=True)
                ],
            }
        )
    for point in points:
        _fits(point["contributed_cents"], *point["balances_cents"])
    middle = (len(rates) - 1) // 2
    at_retirement = points[-1]["balances_cents"]
    reaches = None
    needed = None
    if target > 0:
        reaches = at_retirement[middle] >= target
        r, g, total = monthly_r[middle], grown[middle], 12 * years
        if r == 0:
            raw = Fraction(target - start, total)
        else:
            raw = (target - start * g) * r / (g - 1)
        needed = max(0, round(raw))
        _fits(needed)
    return {
        "years": years,
        "points": points,
        "at_retirement_cents": at_retirement,
        "middle_index": middle,
        "target_cents": target,
        "reaches_target": reaches,
        "monthly_needed_cents": needed,
    }
