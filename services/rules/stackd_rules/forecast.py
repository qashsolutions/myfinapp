"""Upcoming expenses and the 30-day forecast (docs/spec.md "Upcoming expenses & shortfall
forecast", "Rules added for money in & out, imports and the forecast").

Typical daily spending   non-recurring Out over the last 90 days ÷ 90; under 30 days of
                         history → the budgeted needs + wants ÷ days in the month.
Starting balance         the latest balance anchor plus the entries dated after it.
Upcoming                 every confirmed series expanded over the window; an occurrence with a
                         real entry within ±3 days and ±10% is "matched" and not counted again.
Forecast balance (day d) start + expected income up to d − expected bills up to d − typical
                         daily spending × d.
Shortfall                min(forecast balance) < buffer; "short by" is buffer − lowest.

Always an estimate from the user's own history: no guarantees, no AI.
"""

from __future__ import annotations

from datetime import date, timedelta

from . import dates, money, recurring
from .errors import RuleError
from .money import _int

MAX_DAYS = 366


def _days(value: object) -> int:
    days = _int(value, "invalid_days")
    if not 1 <= days <= MAX_DAYS:
        raise RuleError("invalid_days")
    return days


def typical_daily_spending(entries: list, as_of: str, fallback_monthly_cents: int) -> dict:
    today = dates.parse_date(as_of)
    fallback = _int(fallback_monthly_cents)
    if fallback < 0:
        raise RuleError("invalid_amount")
    rows = []
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    for raw in entries:
        if not isinstance(raw, dict):
            raise RuleError("invalid_entry")
        day = dates.parse_date(raw.get("date"))
        cents = _int(raw.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        if raw.get("direction") not in recurring.DIRECTIONS:
            raise RuleError("invalid_direction")
        if not isinstance(raw.get("is_transfer"), bool) or not isinstance(
            raw.get("is_recurring"), bool
        ):
            raise RuleError("invalid_entry")
        rows.append((day, cents, raw["direction"], raw["is_transfer"], raw["is_recurring"]))
    history = [d for d, *_ in rows if d <= today]
    days_of_history = (today - min(history)).days + 1 if history else 0
    if days_of_history < 30:
        if fallback == 0:
            return {"cents_per_day": 0, "basis": "none", "days_of_history": days_of_history}
        per_day = money.round_div(fallback, dates.days_in_month(today))
        return {"cents_per_day": per_day, "basis": "budget", "days_of_history": days_of_history}
    # The window is the history there is, up to 90 days (owner decision, October 29, 2026):
    # 45 days of history divide by 45, never by 90.
    window = min(days_of_history, 90)
    window_start = today - timedelta(days=window - 1)
    spent = sum(
        cents
        for day, cents, direction, is_transfer, is_recurring in rows
        if window_start <= day <= today
        and direction == "out"
        and not is_transfer
        and not is_recurring
    )
    return {
        "cents_per_day": money.round_div(spent, window),
        "basis": "history",
        "days_of_history": days_of_history,
    }


def start_balance(anchor: object, entries: list) -> dict:
    if anchor is None:
        return {"balance_cents": None, "as_of": None, "entries_since": 0}
    if not isinstance(anchor, dict):
        raise RuleError("invalid_anchor")
    anchored = dates.parse_date(anchor.get("as_of"))
    balance = _int(anchor.get("balance_cents"))
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    counted = 0
    for raw in entries:
        if not isinstance(raw, dict):
            raise RuleError("invalid_entry")
        day = dates.parse_date(raw.get("date"))
        cents = _int(raw.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        if raw.get("direction") not in recurring.DIRECTIONS:
            raise RuleError("invalid_direction")
        if day <= anchored:
            continue
        balance += cents if raw["direction"] == "in" else -cents
        counted += 1
    return {"balance_cents": balance, "as_of": anchored.isoformat(), "entries_since": counted}


def _series(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_series")
    series_id = raw.get("id")
    if not isinstance(series_id, str) or not series_id:
        raise RuleError("invalid_series")
    if raw.get("kind") not in ("bill", "income"):
        raise RuleError("invalid_series")
    if raw.get("interval") not in recurring.INTERVALS:
        raise RuleError("invalid_interval")
    cents = _int(raw.get("expected_cents"))
    if cents < 0:
        raise RuleError("invalid_amount")
    # The day of the month a monthly, quarterly or yearly series keeps (31 = the last day), so
    # stepping from a short month never drifts it earlier (October 28, 2026).
    keep = raw.get("day")
    if keep is not None:
        keep = _int(keep, "invalid_series")
        if not 1 <= keep <= 31 or raw["interval"] in ("weekly", "biweekly"):
            raise RuleError("invalid_series")
    return {
        "id": series_id,
        "day": keep,
        "payee": recurring.merchant_key(raw.get("payee")),
        "kind": raw["kind"],
        "interval": raw["interval"],
        "cents": cents,
        "next": dates.parse_date(raw.get("next_date")),
    }


def _next(day: date, s: dict) -> date:
    """One step on, back on the series' own day of the month when it has one (clamped)."""
    return recurring.step_keeping_day(day, s["interval"], s["day"])


def upcoming(series: list, entries: list, as_of: str, days: int) -> dict:
    """Occurrences of every series from as_of through as_of + days, matched to real entries."""
    today = dates.parse_date(as_of)
    horizon = _days(days)
    end = today + timedelta(days=horizon)
    if not isinstance(series, list):
        raise RuleError("invalid_series")
    rows = recurring.entries(entries)
    items = []
    for s in [_series(r) for r in series]:
        day = s["next"]
        while day < today:
            day = _next(day, s)
        while day <= end:
            items.append(
                {
                    "date": day,
                    "series_id": s["id"],
                    "payee": s["payee"],
                    "kind": s["kind"],
                    "amount_cents": s["cents"],
                    "matched": False,
                    "entry_id": None,
                }
            )
            day = _next(day, s)
    items.sort(key=lambda i: (i["date"], i["payee"], i["series_id"]))
    used: set[int] = set()
    for item in items:
        direction = "in" if item["kind"] == "income" else "out"
        for index, e in enumerate(rows):
            if index in used or e["is_transfer"] or e["direction"] != direction:
                continue
            if e["payee"] != item["payee"] or abs((e["date"] - item["date"]).days) > 3:
                continue
            if not recurring.within_ten_percent(e["cents"], item["amount_cents"]):
                continue
            used.add(index)
            item["matched"] = True
            item["entry_id"] = e["id"]
            break
    return {
        "start": today.isoformat(),
        "end": end.isoformat(),
        "items": [{**i, "date": i["date"].isoformat()} for i in items],
    }


def project(
    as_of: str,
    start_balance_cents: int,
    daily_cents: int,
    upcoming_items: list,
    buffer_cents: int,
    days: int,
) -> dict:
    today = dates.parse_date(as_of)
    start = _int(start_balance_cents)
    daily = _int(daily_cents)
    buffer = _int(buffer_cents)
    if daily < 0:
        raise RuleError("invalid_amount")
    horizon = _days(days)
    if not isinstance(upcoming_items, list):
        raise RuleError("invalid_items")
    expected: list[tuple[date, int]] = []
    for raw in upcoming_items:
        if not isinstance(raw, dict) or raw.get("kind") not in ("bill", "income"):
            raise RuleError("invalid_item")
        if not isinstance(raw.get("matched"), bool):
            raise RuleError("invalid_item")
        if raw["matched"]:
            continue  # already in the real balance through the entries since the anchor
        cents = _int(raw.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        expected.append(
            (dates.parse_date(raw.get("date")), cents if raw["kind"] == "income" else -cents)
        )
    series = []
    lowest = start
    lowest_day = today
    first_short: date | None = None if start >= buffer else today
    for d in range(0, horizon + 1):
        day = today + timedelta(days=d)
        balance = start - daily * d + sum(c for when, c in expected if when <= day)
        series.append({"date": day.isoformat(), "balance_cents": balance})
        if balance < lowest:
            lowest, lowest_day = balance, day
        if first_short is None and balance < buffer:
            first_short = day
    return {
        "days": series,
        "lowest_cents": lowest,
        "lowest_date": lowest_day.isoformat(),
        "end_cents": series[-1]["balance_cents"],
        "shortfall": lowest < buffer,
        "short_by_cents": max(0, buffer - lowest),
        "first_short_date": first_short.isoformat() if first_short is not None else None,
    }
