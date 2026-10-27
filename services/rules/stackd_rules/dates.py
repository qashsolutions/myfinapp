"""Calendar math for as_of-driven rules: months, weeks, cadences and paydays.

Dates are ISO strings at the boundary. No times, no time zones: the caller passes the
user's local calendar date as as_of. A payday schedule is one of
  {"kind": "every_n_days", "anchor": "YYYY-MM-DD", "n": 14}   (any known payday + interval)
  {"kind": "monthly_days", "days": [1, 15]}                   (days clamp to month end)
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Iterator
from datetime import date, timedelta

from .errors import RuleError

_ISO = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")  # ASCII only, see money.py
CADENCES = ("weekly", "biweekly", "monthly", "payday")
_MAX_COUNT = 1000


def parse_date(value: object) -> date:
    if not isinstance(value, str) or not _ISO.fullmatch(value):
        raise RuleError("invalid_date")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise RuleError("invalid_date") from exc


def days_in_month(d: date) -> int:
    return calendar.monthrange(d.year, d.month)[1]


def month_bounds(as_of: date) -> tuple[date, date]:
    return as_of.replace(day=1), as_of.replace(day=days_in_month(as_of))


def add_months(d: date, months: int) -> date:
    """Calendar months forward or back; the day clamps to the target month's length."""
    if isinstance(months, bool) or not isinstance(months, int):
        raise RuleError("invalid_integer")
    span = d.month - 1 + months
    year, month = d.year + span // 12, span % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def add_days(day: date, days: int) -> date:
    """Calendar days forward (or back when negative)."""
    if isinstance(days, bool) or not isinstance(days, int):
        raise RuleError("invalid_integer")
    return day + timedelta(days=days)


def days_until(as_of: date, target: date) -> int:
    """Signed day count; negative when target is in the past."""
    return (target - as_of).days


def _validated_schedule(schedule: object) -> dict:
    if not isinstance(schedule, dict):
        raise RuleError("invalid_schedule")
    kind = schedule.get("kind")
    if kind == "every_n_days":
        n = schedule.get("n")
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            raise RuleError("invalid_schedule")
        try:
            anchor = parse_date(schedule.get("anchor"))
        except RuleError as exc:
            raise RuleError("invalid_schedule") from exc
        return {"kind": kind, "anchor": anchor, "n": n}
    if kind == "monthly_days":
        days = schedule.get("days")
        if not isinstance(days, list) or not days:
            raise RuleError("invalid_schedule")
        for day in days:
            if isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 31:
                raise RuleError("invalid_schedule")
        return {"kind": kind, "days": sorted(set(days))}
    raise RuleError("invalid_schedule")


def iter_paydays(as_of: date, schedule: object) -> Iterator[date]:
    """Paydays strictly after as_of, ascending, forever (callers slice)."""
    s = _validated_schedule(schedule)
    if s["kind"] == "every_n_days":
        n = s["n"]
        k = (as_of - s["anchor"]).days // n + 1
        current = s["anchor"] + timedelta(days=k * n)
        while True:
            yield current
            current += timedelta(days=n)
    else:
        month_start = as_of.replace(day=1)
        while True:
            last = days_in_month(month_start)
            seen: set[int] = set()
            for day in s["days"]:
                actual = min(day, last)
                if actual in seen:
                    continue
                seen.add(actual)
                payday = month_start.replace(day=actual)
                if payday > as_of:
                    yield payday
            month_start = add_months(month_start, 1)


def next_paydays(as_of: date, schedule: object, count: int) -> list[date]:
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= _MAX_COUNT:
        raise RuleError("invalid_count")
    out: list[date] = []
    if count == 0:
        _validated_schedule(schedule)
        return out
    for payday in iter_paydays(as_of, schedule):
        out.append(payday)
        if len(out) == count:
            return out
    return out


def periods_until(as_of: date, deadline: date, cadence: str, schedule: object = None) -> int:
    """How many cadence periods remain: the smallest k >= 0 with as_of + k periods >= deadline.

    weekly / biweekly count 7 / 14-day steps; monthly counts calendar months (clamped);
    payday counts paydays in (as_of, deadline]. Deadline on or before as_of -> 0.
    """
    if cadence not in CADENCES:
        raise RuleError("invalid_cadence")
    if cadence == "payday" and schedule is None:
        raise RuleError("schedule_required")
    if cadence == "payday":
        _validated_schedule(schedule)
    if deadline <= as_of:
        return 0
    days = days_until(as_of, deadline)
    if cadence == "weekly":
        return (days + 6) // 7
    if cadence == "biweekly":
        return (days + 13) // 14
    if cadence == "monthly":
        k = 0
        while add_months(as_of, k) < deadline:
            k += 1
        return k
    count = 0
    for payday in iter_paydays(as_of, schedule):
        if payday > deadline:
            break
        count += 1
    return count
