"""Growth projection for Later (docs/spec.md "Calculation rules", growth.projection).

Balances follow FV = start × (1 + r)^n + P × ((1 + r)^n − 1) ÷ r with r = annual rate ÷ 12,
computed exactly as fractions and rounded half-even once, so both engines agree to the cent.
An illustration using the rates the person enters: not a prediction, not advice.
(growth.compound, the old one-rate calculator, was removed October 27, 2026: Later replaced it.)
"""

from __future__ import annotations

from fractions import Fraction

from .dates import add_months, parse_date
from .errors import RuleError
from .money import _int

MAX_RATE_BPS = 50000  # 500% a year is already nonsense; anything above is a typo
MONTHS_BPS = 120000  # 12 months × 10000 bps
# The most cents both engines count exactly (2^53 − 1, JavaScript's largest safe integer): any
# amount in or out above it is `too_large`, so the two engines never differ (October 27, 2026).
MAX_CENTS = 2**53 - 1


def _fits(*cents: int) -> None:
    if any(c > MAX_CENTS for c in cents):
        raise RuleError("too_large")


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


# Goals that grow (October 28, 2026; values signed off by the owner, October 29, 2026): a save jar
# whose cost rises each year while the money put aside grows at the person's own rate.
MAX_GOAL_MONTHS = (
    780  # 65 years (owner sign-off, October 29, 2026): the furthest a grows goal can be
)


def months_between(start: str, end: str) -> int:
    """Calendar months from start's month to end's month (days ignored): Oct → next Oct = 12."""
    a, b = parse_date(start), parse_date(end)
    return (b.year - a.year) * 12 + (b.month - a.month)


def goal_plan(
    today_cost_cents: int,
    cost_rise_bps: int,
    return_bps: int,
    saved_cents: int,
    as_of: str,
    target_date: str,
    priced_on: str | None = None,
) -> dict:
    """A goal that grows (docs/spec.md "Calculation rules", growth.goal_plan).

    The cost T, priced on `priced_on` (default as_of), rises monthly at c ÷ 12 for m months
    (priced_on's month to the target's month): F = T × (1 + c/12)^m. What is saved grows at
    i = r ÷ 12 for n months (as_of's month to the target's month): g = (1 + i)^n. The monthly
    amount P, put in at each month's end, solves F = S × g + P × (g − 1) ÷ i (i = 0 →
    F = S + P × n); P = max(0, …). Exact fractions, each output rounded half-even once.
    An illustration at the rates the person sets: not a prediction, not advice."""
    today = _int(today_cost_cents)
    rise = _int(cost_rise_bps)
    rate = _int(return_bps)
    saved = _int(saved_cents)
    if today <= 0 or saved < 0:
        raise RuleError("invalid_amount")
    if not 0 <= rise <= MAX_RATE_BPS or not 0 <= rate <= MAX_RATE_BPS:
        raise RuleError("invalid_rate")
    priced = as_of if priced_on is None else priced_on
    if parse_date(priced) > parse_date(as_of):
        raise RuleError("invalid_date")
    if parse_date(target_date) < parse_date(as_of):
        raise RuleError("deadline_in_past")
    months = months_between(as_of, target_date)
    if months == 0:
        raise RuleError("too_soon")
    cost_months = months_between(priced, target_date)
    if cost_months > MAX_GOAL_MONTHS:
        raise RuleError("too_far")
    future = today * (1 + Fraction(rise, MONTHS_BPS)) ** cost_months
    i = Fraction(rate, MONTHS_BPS)
    grown = (1 + i) ** months
    saved_grows = saved * grown
    raw = Fraction(future - saved, months) if i == 0 else (future - saved_grows) * i / (grown - 1)
    out = {
        "months": months,
        "cost_months": cost_months,
        "future_cost_cents": round(future),
        "saved_grows_to_cents": round(saved_grows),
        "monthly_needed_cents": max(0, round(raw)),
        "already_enough": saved_grows >= future,
    }
    _fits(out["future_cost_cents"], out["saved_grows_to_cents"], out["monthly_needed_cents"])
    return out


def _needed(t: int, s: int, p_rate: int, cost_up: int, cost_base: int, up: int, base: int, k: int):
    """goal_plan's monthly amount for a date k months on, as an exact Fraction (>= 0), from
    T (M + c)^q ÷ M^q and (M + r)^k ÷ M^k kept as integers; k >= 1."""
    if p_rate == 0:
        num, den = t * cost_up - s * cost_base, k * cost_base
    else:
        num = (t * cost_up * base - s * up * cost_base) * p_rate
        den = cost_base * MONTHS_BPS * (up - base)
    return Fraction(max(0, num), den)


def goal_reach(
    today_cost_cents: int,
    cost_rise_bps: int,
    return_bps: int,
    saved_cents: int,
    monthly_cents: int,
    as_of: str,
    target_date: str,
    priced_on: str | None = None,
) -> dict:
    """What a chosen monthly amount does for a goal that grows (docs/spec.md "Calculation rules",
    growth.goal_reach; October 29, 2026). Same inputs and limits as goal_plan plus P, the amount
    put in at each month's end. Month k (k = 0 is as_of's month) counts as reached when
    goal_plan's monthly amount for a date k months on, rounded half-even, is at most P (k = 0:
    S ≥ the cost now), so the plan's own amount always reaches at the target. The first such k
    within 65 years of `priced_on` is the reach month. At the target: whether it is reached
    there, the savings S × g + P × (g − 1) ÷ i, and how far short of the cost then (0 when
    reached). Yearly points (k = 0, 12, 24, …, then the target)
    give the cost and the savings, for the chart. An illustration, not a prediction or advice."""
    plan = goal_plan(
        today_cost_cents, cost_rise_bps, return_bps, saved_cents, as_of, target_date, priced_on
    )
    monthly = _int(monthly_cents)
    if monthly < 0:
        raise RuleError("invalid_amount")
    _fits(monthly)
    t, s, c, r = _int(today_cost_cents), _int(saved_cents), _int(cost_rise_bps), _int(return_bps)
    priced = as_of if priced_on is None else priced_on
    offset = months_between(priced, as_of)
    n = plan["months"]
    m_ = MONTHS_BPS
    cost_up, cost_base = (m_ + c) ** offset, m_**offset
    up, base = 1, 1
    first = parse_date(as_of).replace(day=1)
    reach = None
    by_target = False
    points = []
    at_target = cost_at_target = Fraction(0)
    for k in range(MAX_GOAL_MONTHS - offset + 1):
        if k:
            cost_up, cost_base = cost_up * (m_ + c), cost_base * m_
            up, base = up * (m_ + r), base * m_
        if reach is None or k == n:
            if k == 0:
                hit = s * cost_base >= t * cost_up
            else:
                hit = round(_needed(t, s, r, cost_up, cost_base, up, base, k)) <= monthly
            if hit and reach is None:
                reach = k
            if k == n:
                by_target = hit
        if k <= n and (k % 12 == 0 or k == n):
            cost = Fraction(t * cost_up, cost_base)
            if r == 0:
                saved = Fraction(s + monthly * k)
            else:
                saved = Fraction(s * up * r + monthly * m_ * (up - base), r * base)
            points.append(
                {
                    "month": add_months(first, k).isoformat()[:7],
                    "months": k,
                    "cost_cents": round(cost),
                    "saved_cents": round(saved),
                }
            )
            if k == n:
                at_target, cost_at_target = saved, cost
        if k >= n and reach is not None:
            break
    out = {
        "months": n,
        "target_cost_cents": plan["future_cost_cents"],
        "at_target_cents": round(at_target),
        "short_by_cents": 0 if by_target else max(0, round(cost_at_target - at_target)),
        "reaches_by_target": by_target,
        "reach_months": reach,
        "reach_month": None if reach is None else add_months(first, reach).isoformat()[:7],
        "points": points,
    }
    _fits(out["at_target_cents"], out["short_by_cents"])
    for point in points:
        _fits(point["cost_cents"], point["saved_cents"])
    return out


def goal_pace(plan_monthly_cents: int, deposited_cents: int, start_date: str, as_of: str) -> dict:
    """Ahead, on track or behind a grows-over-time plan (docs/spec.md, growth.goal_pace): the
    plan asks P a month from the start month, this month included, so by now it asked
    expected = P × (k + 1), k = months from the start's month to as_of's month. A month's worth
    or more over is ahead; more than a month's worth under is behind; between is on track."""
    plan = _int(plan_monthly_cents)
    deposited = _int(deposited_cents)
    if plan < 0:
        raise RuleError("invalid_amount")
    if parse_date(start_date) > parse_date(as_of):
        raise RuleError("invalid_date")
    months_in = months_between(start_date, as_of) + 1
    expected = plan * months_in
    _fits(expected)
    if deposited >= expected + plan:
        status = "ahead"
    elif deposited < expected - plan:
        status = "behind"
    else:
        status = "on_track"
    return {"months_in": months_in, "expected_cents": expected, "status": status}
