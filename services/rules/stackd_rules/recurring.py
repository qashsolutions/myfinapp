"""Recurring series detection (docs/spec.md "Upcoming expenses & shortfall forecast").

Recurring series   same payee, amount within ±10% of the series median, at least 3 occurrences
                   at a weekly (7 ±3 days), every-2-weeks (14 ±3) or monthly (28–31 ±3)
                   interval, or at least 2 at a quarterly (80–100 days) or yearly (350–380)
                   one (fast-follow 8). Suggested only; the user confirms, edits or dismisses.

The payee is the entry's merchant text cleaned like a fingerprint (trimmed, single spaces,
ASCII upper-case), so "Netflix.com" and "NETFLIX.COM " are one payee. Only the most recent run
of evenly spaced occurrences counts: a payee whose spacing changed is judged on the new pattern.
Transfers are never bills.
"""

from __future__ import annotations

from datetime import date, timedelta

from . import dates, money
from .errors import RuleError
from .fingerprint import clean_description
from .money import _int

INTERVALS = ("weekly", "biweekly", "monthly", "quarterly", "yearly")
GAPS = {
    "weekly": (4, 10),
    "biweekly": (11, 17),
    "monthly": (25, 34),
    "quarterly": (80, 100),
    "yearly": (350, 380),
}
MIN_RUN = {"weekly": 3, "biweekly": 3, "monthly": 3, "quarterly": 2, "yearly": 2}
DIRECTIONS = ("in", "out")


def _entry(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_entry")
    day = dates.parse_date(raw.get("date"))
    cents = _int(raw.get("amount_cents"))
    if cents < 0:
        raise RuleError("invalid_amount")
    if raw.get("direction") not in DIRECTIONS:
        raise RuleError("invalid_direction")
    if not isinstance(raw.get("is_transfer"), bool):
        raise RuleError("invalid_entry")
    entry_id = raw.get("id")
    if entry_id is not None and not isinstance(entry_id, str):
        raise RuleError("invalid_entry")
    payee = clean_description(raw.get("payee"))
    return {
        "id": entry_id,
        "date": day,
        "cents": cents,
        "direction": raw["direction"],
        "is_transfer": raw["is_transfer"],
        "payee": payee,
    }


def entries(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_entries")
    return [_entry(e) for e in raw]


def interval_of(gap_days: int) -> str | None:
    for name in INTERVALS:
        lo, hi = GAPS[name]
        if lo <= gap_days <= hi:
            return name
    return None


def step(day: date, interval: str) -> date:
    if interval == "weekly":
        return day + timedelta(days=7)
    if interval == "biweekly":
        return day + timedelta(days=14)
    if interval == "monthly":
        return dates.add_months(day, 1)
    if interval == "quarterly":
        return dates.add_months(day, 3)
    if interval == "yearly":
        return dates.add_months(day, 12)
    raise RuleError("invalid_interval")


def median_cents(values: list[int]) -> int:
    ordered = sorted(values)
    n = len(ordered)
    if n % 2:
        return ordered[n // 2]
    return money.round_div(ordered[n // 2 - 1] + ordered[n // 2], 2)


def within_ten_percent(cents: int, reference: int) -> bool:
    return 9 * reference <= 10 * cents <= 11 * reference


def detect(entries_in: list, as_of: str) -> dict:
    today = dates.parse_date(as_of)
    rows = [e for e in entries(entries_in) if not e["is_transfer"] and e["date"] <= today]
    groups: dict[tuple[str, str], list[dict]] = {}
    for e in rows:
        groups.setdefault((e["payee"], e["direction"]), []).append(e)
    series = []
    for (payee, direction), items in sorted(groups.items()):
        items.sort(key=lambda e: (e["date"], e["cents"], e["id"] or ""))
        if len(items) < 2:
            continue
        last_gap = (items[-1]["date"] - items[-2]["date"]).days
        interval = interval_of(last_gap)
        if interval is None:
            continue
        lo, hi = GAPS[interval]
        start = len(items) - 2
        while start > 0 and lo <= (items[start]["date"] - items[start - 1]["date"]).days <= hi:
            start -= 1
        run = items[start:]
        if len(run) < MIN_RUN[interval]:
            continue
        expected = median_cents([e["cents"] for e in run])
        if not all(within_ten_percent(e["cents"], expected) for e in run):
            continue
        last = run[-1]["date"]
        series.append(
            {
                "payee": payee,
                "kind": "income" if direction == "in" else "bill",
                "direction": direction,
                "expected_cents": expected,
                "interval": interval,
                "last_date": last.isoformat(),
                "next_date": step(last, interval).isoformat(),
                "occurrences": len(run),
                "entry_ids": [e["id"] for e in run if e["id"] is not None],
            }
        )
    return {"series": series}
