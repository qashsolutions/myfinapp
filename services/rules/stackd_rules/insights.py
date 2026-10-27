"""Insights from the user's own history (fast-follow 8; docs/spec.md "Rules added for money in &
out, imports and the forecast"). Every number is arithmetic over entries, bills and the
forecast the device already has: no model, no network. Thresholds come from config
(config/next_move.yaml), passed in so these stay pure.

safe_to_spend   the forecast's lowest balance before the next payday, minus the buffer
vs_usual        categories running above the same days of recent months
lumpy_bills     quarterly / yearly bills ahead, with a monthly amount to set aside
seasonal        months that ran high last year, coming up again
"""

from __future__ import annotations

from datetime import date

from . import dates, money, recurring
from .errors import RuleError
from .fingerprint import clean_description
from .money import _int

LUMPY = ("quarterly", "yearly")


def _threshold(thresholds: object, key: str) -> int:
    if not isinstance(thresholds, dict):
        raise RuleError("invalid_thresholds")
    value = thresholds.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RuleError("invalid_thresholds")
    return value


def _month_key(day: date) -> str:
    return day.strftime("%Y-%m")


def _month_start(day: date) -> date:
    return day.replace(day=1)


# --- safe to spend ------------------------------------------------------------------------


def safe_to_spend(days: list, buffer_cents: int, as_of: str, until: str) -> dict:
    today = dates.parse_date(as_of)
    last = dates.parse_date(until)
    buffer = _int(buffer_cents)
    if not isinstance(days, list):
        raise RuleError("invalid_days")
    window: list[tuple[date, int]] = []
    for raw in days:
        if not isinstance(raw, dict):
            raise RuleError("invalid_days")
        day = dates.parse_date(raw.get("date"))
        balance = _int(raw.get("balance_cents"))
        if today <= day <= last:
            window.append((day, balance))
    if not window:
        raise RuleError("invalid_range")
    window.sort()
    lowest_day, lowest = window[0]
    for day, balance in window:
        if balance < lowest:
            lowest_day, lowest = day, balance
    safe = max(0, lowest - buffer)
    return {
        "safe_cents": safe,
        "per_day_cents": money.round_div(safe, len(window)),
        "until": window[-1][0].isoformat(),
        "days": len(window),
        "lowest_cents": lowest,
        "lowest_date": lowest_day.isoformat(),
    }


# --- more than usual ----------------------------------------------------------------------


def _spend_rows(entries: object) -> list[dict]:
    """Net spend per entry: out counts, a refund (money in, expense category) subtracts."""
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    rows = []
    for raw in entries:
        if not isinstance(raw, dict):
            raise RuleError("invalid_entry")
        day = dates.parse_date(raw.get("date"))
        cents = _int(raw.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        direction = raw.get("direction")
        if direction not in ("in", "out"):
            raise RuleError("invalid_direction")
        if not isinstance(raw.get("is_transfer"), bool):
            raise RuleError("invalid_entry")
        kind = raw.get("category_kind")
        if kind not in ("expense", "income", None):
            raise RuleError("invalid_category")
        category = raw.get("category_id")
        if category is not None and not isinstance(category, str):
            raise RuleError("invalid_category")
        net = 0
        if not raw["is_transfer"] and kind == "expense":
            net = cents if direction == "out" else -cents
        rows.append({"date": day, "net": net, "category_id": category})
    return rows


def vs_usual(as_of: str, entries: list, thresholds: dict, months: int) -> dict:
    today = dates.parse_date(as_of)
    floor_cents = _threshold(thresholds, "usual_increase_cents")
    floor_bps = _threshold(thresholds, "usual_increase_bps")
    lookback = _int(months)
    if lookback < 1:
        raise RuleError("invalid_months")
    rows = _spend_rows(entries)
    this_month = _month_start(today)
    current: dict[str, int] = {}
    for r in rows:
        if this_month <= r["date"] <= today and r["category_id"] is not None and r["net"]:
            current[r["category_id"]] = current.get(r["category_id"], 0) + r["net"]
    used = 0
    past: dict[str, int] = {}
    for back in range(1, lookback + 1):
        start = dates.add_months(this_month, -back)
        end = start.replace(day=min(today.day, dates.days_in_month(start)))
        month_end = start.replace(day=dates.days_in_month(start))
        if not any(start <= r["date"] <= month_end for r in rows):
            continue  # a month with no entries at all is missing data, not zero spend
        used += 1
        for r in rows:
            if start <= r["date"] <= end and r["category_id"] is not None and r["net"]:
                past[r["category_id"]] = past.get(r["category_id"], 0) + r["net"]
    flagged = []
    if used:
        for category, now in current.items():
            usual = money.round_div(past.get(category, 0), used)
            increase = now - usual
            if increase >= floor_cents and now * 10000 >= usual * (10000 + floor_bps):
                flagged.append(
                    {
                        "category_id": category,
                        "current_cents": now,
                        "usual_cents": usual,
                        "increase_cents": increase,
                    }
                )
    flagged.sort(key=lambda f: (-f["increase_cents"], f["category_id"]))
    return {"months_used": used, "flagged": flagged}


# --- bigger months ahead ------------------------------------------------------------------


def lumpy_bills(as_of: str, series: list, thresholds: dict, months: int) -> dict:
    today = dates.parse_date(as_of)
    big_cents = _threshold(thresholds, "lumpy_month_cents")
    horizon = _int(months)
    if horizon < 1:
        raise RuleError("invalid_months")
    if not isinstance(series, list):
        raise RuleError("invalid_series")
    first_month = _month_start(today)
    last_month = dates.add_months(first_month, horizon - 1)
    last_day = last_month.replace(day=dates.days_in_month(last_month))
    bills = []
    totals: dict[str, int] = {}
    for raw in series:
        if not isinstance(raw, dict):
            raise RuleError("invalid_series")
        interval = raw.get("interval")
        if interval not in recurring.INTERVALS:
            raise RuleError("invalid_interval")
        if raw.get("kind") not in ("bill", "income"):
            raise RuleError("invalid_series")
        cents = _int(raw.get("expected_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        payee = recurring.clean_description(raw.get("payee"))
        due = dates.parse_date(raw.get("next_date"))
        if raw["kind"] != "bill" or interval not in LUMPY:
            continue
        while due < today:
            due = recurring.step(due, interval)
        months_to_save = (due.year - today.year) * 12 + due.month - today.month + 1
        bills.append(
            {
                "payee": payee,
                "interval": interval,
                "due_date": due.isoformat(),
                "amount_cents": cents,
                "months_to_save": months_to_save,
                "per_month_cents": money.round_div(cents, months_to_save),
            }
        )
        occurrence = due
        while occurrence <= last_day:
            key = _month_key(occurrence)
            totals[key] = totals.get(key, 0) + cents
            occurrence = recurring.step(occurrence, interval)
    bills.sort(key=lambda b: (b["due_date"], b["payee"]))
    return {
        "bills": bills,
        "months": [
            {"month": key, "total_cents": totals[key], "big": totals[key] >= big_cents}
            for key in sorted(totals)
        ],
    }


# --- seasonal spikes ----------------------------------------------------------------------


def seasonal(as_of: str, entries: list, thresholds: dict) -> dict:
    today = dates.parse_date(as_of)
    floor_cents = _threshold(thresholds, "seasonal_increase_cents")
    floor_bps = _threshold(thresholds, "seasonal_increase_bps")
    rows = _spend_rows(entries)
    this_month = _month_start(today)
    by_month: dict[str, int] = {}
    with_entries: set[str] = set()
    for r in rows:
        key = _month_key(r["date"])
        with_entries.add(key)
        by_month[key] = by_month.get(key, 0) + r["net"]
    history = [
        _month_key(dates.add_months(this_month, -back))
        for back in range(1, 13)
        if _month_key(dates.add_months(this_month, -back)) in with_entries
    ]
    flagged = []
    if len(history) >= 6:
        usual = money.round_div(sum(by_month.get(key, 0) for key in history), len(history))
        for ahead in (1, 2):
            month = dates.add_months(this_month, ahead)
            last_year = _month_key(dates.add_months(month, -12))
            if last_year not in with_entries:
                continue
            spent = by_month.get(last_year, 0)
            increase = spent - usual
            if increase >= floor_cents and spent * 10000 >= usual * (10000 + floor_bps):
                flagged.append(
                    {
                        "month": _month_key(month),
                        "last_year_month": last_year,
                        "last_year_cents": spent,
                        "usual_cents": usual,
                        "increase_cents": increase,
                    }
                )
    return {"months_of_history": len(history), "flagged": flagged}


def _top_row(raw: object) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        raise RuleError("invalid_entry")
    cents = _int(raw.get("amount_cents"), "invalid_amount")
    if cents < 0:
        raise RuleError("invalid_amount")
    if raw.get("direction") not in ("in", "out") or not isinstance(raw.get("is_transfer"), bool):
        raise RuleError("invalid_entry")
    payee = raw.get("payee")
    if payee is not None and not isinstance(payee, str):
        raise RuleError("invalid_description")
    return {
        "id": raw["id"],
        "date": dates.parse_date(raw.get("date")),
        "cents": cents,
        "out": raw["direction"] == "out" and not raw["is_transfer"],
        "payee": payee,
        "key": clean_description(payee) if payee is not None else "",
    }


def top_spending(start: str, end: str, entries: list, limit: int) -> dict:
    """The biggest single amounts out and the merchants paid most often between two dates."""
    first, last = dates.parse_date(start), dates.parse_date(end)
    if last < first:
        raise RuleError("invalid_range")
    n = _int(limit, "invalid_limit")
    if not 1 <= n <= 20:
        raise RuleError("invalid_limit")
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    rows = [r for r in (_top_row(e) for e in entries) if r["out"] and first <= r["date"] <= last]
    by_size = sorted(rows, key=lambda r: r["id"])
    by_size.sort(key=lambda r: r["date"], reverse=True)
    by_size.sort(key=lambda r: r["cents"], reverse=True)
    largest = [
        {
            "id": r["id"],
            "date": r["date"].isoformat(),
            "amount_cents": r["cents"],
            "payee": r["payee"],
        }
        for r in by_size[:n]
    ]
    groups: dict[str, list[dict]] = {}
    for r in rows:
        if r["key"]:
            groups.setdefault(r["key"], []).append(r)
    merchants = []
    for key, items in groups.items():
        # the latest date; on the same day the smallest id (max keeps the first of equals)
        latest = max(sorted(items, key=lambda r: r["id"]), key=lambda r: r["date"])
        merchants.append(
            {
                "key": key,
                "name": latest["payee"].strip(),
                "count": len(items),
                "total_cents": sum(r["cents"] for r in items),
                "last_date": latest["date"].isoformat(),
            }
        )
    merchants.sort(key=lambda m: (-m["count"], -m["total_cents"], m["key"]))
    return {"largest": largest, "merchants": merchants[:n], "count": len(rows)}
