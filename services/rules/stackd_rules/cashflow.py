"""Money in & out (docs/spec.md "Money in & out (day 1)" and "Rules added for money in & out").

Month In   sum of money-in entries in the month, excluding transfers; a refund (money in with
           an expense category) nets against that category instead, unless the user marked it
           as income by giving it an income category.
Month Out  sum of money-out entries in the month, excluding transfers, minus refunds.
Net (kept) In − Out; may be negative.
Transfers  opposite amounts between two of the user's accounts within 5 days; suggested only.

Entries are passed in with their category kind, so the rule stays pure.
"""

from __future__ import annotations

from datetime import date

from . import dates, money
from .errors import RuleError
from .money import _int

DIRECTIONS = ("in", "out")
KINDS = ("expense", "income", None)


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
    kind = raw.get("category_kind")
    if kind not in KINDS:
        raise RuleError("invalid_category")
    category = raw.get("category_id")
    if category is not None and not isinstance(category, str):
        raise RuleError("invalid_category")
    account = raw.get("account_id")
    if not isinstance(account, str) or not account:
        raise RuleError("invalid_account")
    entry_id = raw.get("id")
    if entry_id is not None and not isinstance(entry_id, str):
        raise RuleError("invalid_entry")
    return {
        "id": entry_id,
        "date": day,
        "cents": cents,
        "direction": raw["direction"],
        "is_transfer": raw["is_transfer"],
        "category_id": category,
        "category_kind": kind,
        "account_id": account,
    }


def _entries(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_entries")
    return [_entry(e) for e in raw]


def month_totals(as_of: str, entries: list) -> dict:
    """In, Out, Net for the month that contains as_of, plus by-category and by-account sums."""
    start, end = dates.month_bounds(dates.parse_date(as_of))
    return _totals(start, end, _entries(entries))


def period_totals(start: str, end: str, entries: list) -> dict:
    """The same totals between two dates inclusive: the weekly recap's week (fast-follow 6)."""
    first = dates.parse_date(start)
    last = dates.parse_date(end)
    if last < first:
        raise RuleError("invalid_range")
    return _totals(first, last, _entries(entries))


STEPS = ("week", "month", "quarter")


def _steps(start: date, end: date, step: str) -> list[tuple[date, date]]:
    """Seven-day blocks from the start, or calendar months / quarters, each cut to the range."""
    out: list[tuple[date, date]] = []
    if step == "week":
        first = start
        while first <= end:
            last = min(dates.add_days(first, 6), end)
            out.append((first, last))
            first = dates.add_days(last, 1)
        return out
    months = 1 if step == "month" else 3
    first = date(start.year, start.month - (start.month - 1) % months, 1)
    while first <= end:
        nxt = dates.add_months(first, months)
        out.append((max(first, start), min(dates.add_days(nxt, -1), end)))
        first = nxt
    return out


def series(start: str, end: str, step: str, entries: list) -> dict:
    """Range totals split into steps, with averages a month over months that have entries."""
    first = dates.parse_date(start)
    last = dates.parse_date(end)
    if last < first:
        raise RuleError("invalid_range")
    if step not in STEPS:
        raise RuleError("invalid_step")
    parsed = _entries(entries)
    whole = _totals(first, last, parsed)
    steps = []
    for a, b in _steps(first, last, step):
        t = _totals(a, b, parsed)
        steps.append(
            {
                "start": t["start"],
                "end": t["end"],
                "in_cents": t["in_cents"],
                "out_cents": t["out_cents"],
                "net_cents": t["net_cents"],
                "count": t["count"],
            }
        )
    active = {
        (e["date"].year, e["date"].month)
        for e in parsed
        if first <= e["date"] <= last and not e["is_transfer"]
    }
    n = len(active)

    def avg(cents: int) -> int | None:
        return money.round_div(cents, n) if n else None

    return {
        "start": whole["start"],
        "end": whole["end"],
        "step": step,
        "steps": steps,
        "in_cents": whole["in_cents"],
        "out_cents": whole["out_cents"],
        "net_cents": whole["net_cents"],
        "count": whole["count"],
        "by_category": whole["by_category"],
        "active_months": n,
        "avg_in_cents": avg(whole["in_cents"]),
        "avg_out_cents": avg(whole["out_cents"]),
        "avg_net_cents": avg(whole["net_cents"]),
        "first_date": min(e["date"] for e in parsed).isoformat() if parsed else None,
    }


def _totals(start: date, end: date, parsed: list[dict]) -> dict:
    rows = [e for e in parsed if start <= e["date"] <= end]
    in_cents = 0
    out_cents = 0
    transfers_out = 0
    count = 0
    by_category: dict[str | None, int] = {}
    by_account: dict[str, dict[str, int]] = {}
    for e in rows:
        account = by_account.setdefault(e["account_id"], {"in_cents": 0, "out_cents": 0})
        if e["is_transfer"]:
            if e["direction"] == "out":
                transfers_out += e["cents"]
            continue
        count += 1
        if e["direction"] == "out":
            out_cents += e["cents"]
            account["out_cents"] += e["cents"]
            by_category[e["category_id"]] = by_category.get(e["category_id"], 0) + e["cents"]
        elif e["category_kind"] == "expense":
            # a refund: nets against its category, not money in
            out_cents -= e["cents"]
            account["out_cents"] -= e["cents"]
            by_category[e["category_id"]] = by_category.get(e["category_id"], 0) - e["cents"]
        else:
            in_cents += e["cents"]
            account["in_cents"] += e["cents"]
    categories = sorted(by_category.items(), key=lambda kv: (-kv[1], kv[0] is None, kv[0] or ""))
    accounts = sorted(by_account.items())
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "in_cents": in_cents,
        "out_cents": out_cents,
        "net_cents": in_cents - out_cents,
        "transfers_out_cents": transfers_out,
        "count": count,
        "by_category": [{"category_id": c, "out_cents": v} for c, v in categories],
        "by_account": [{"account_id": a, **v} for a, v in accounts],
    }


def net_change(net_cents: int, previous_net_cents: int) -> int:
    """ "vs September: you kept $96 more" is net − previous net."""
    return _int(net_cents) - _int(previous_net_cents)


def match_transfers(entries: list, window_days: int = 5) -> list[dict]:
    """Pairs of opposite, equal amounts in different accounts within `window_days`.

    Each entry is used at most once; the closest dates win, ties go to the earlier date, then
    the smaller id. Entries already marked as transfers are not considered. Suggested only.
    """
    window = _int(window_days)
    if window < 0:
        raise RuleError("invalid_window")
    rows = [e for e in _entries(entries) if not e["is_transfer"]]
    if any(e["id"] is None for e in rows):
        raise RuleError("invalid_entry")
    outs = sorted((e for e in rows if e["direction"] == "out"), key=lambda e: (e["date"], e["id"]))
    ins = sorted((e for e in rows if e["direction"] == "in"), key=lambda e: (e["date"], e["id"]))
    used: set[str] = set()
    pairs = []
    for o in outs:
        best = None
        best_key: tuple[int, date, str] | None = None
        for i in ins:
            if i["id"] in used or i["account_id"] == o["account_id"] or i["cents"] != o["cents"]:
                continue
            gap = abs((i["date"] - o["date"]).days)
            if gap > window:
                continue
            key = (gap, i["date"], i["id"])
            if best_key is None or key < best_key:
                best, best_key = i, key
        if best is not None and best_key is not None:
            used.add(best["id"])
            pairs.append({"out_id": o["id"], "in_id": best["id"], "days_apart": best_key[0]})
    return pairs


BUCKETS = ("need", "want", "save", None)
BUCKET_KEYS = ("need", "want", "save", "none")


def _flex_entry(raw: object) -> dict:
    e = _entry(raw)
    assert isinstance(raw, dict)
    recurring = raw.get("is_recurring")
    if not isinstance(recurring, bool):
        raise RuleError("invalid_entry")
    bucket = raw.get("bucket")
    if bucket not in BUCKETS:
        raise RuleError("invalid_bucket")
    return {**e, "is_recurring": recurring, "bucket": bucket}


def _category_order(c: dict, cents_key: str) -> tuple:
    return (-c[cents_key], c["category_id"] is None, c["category_id"] or "")


def fixed_flexible(start: str, end: str, entries: list) -> dict:
    """Fixed vs flexible money out and the kept rate (docs/spec.md "Fixed vs flexible").

    Fixed is counted money out of entries in a confirmed bill or subscription run
    (`is_recurring`); flexible is the rest. A refund (money in with an expense category) nets
    against its own part, bucket and category, as in Month Out. Transfers never count.
    """
    first = dates.parse_date(start)
    last = dates.parse_date(end)
    if last < first:
        raise RuleError("invalid_range")
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    rows = [e for e in (_flex_entry(r) for r in entries) if first <= e["date"] <= last]
    in_cents = 0
    parts = {
        "fixed": dict.fromkeys(BUCKET_KEYS, 0),
        "flexible": dict.fromkeys(BUCKET_KEYS, 0),
    }
    by_category: dict[str | None, dict] = {}
    for e in rows:
        if e["is_transfer"]:
            continue
        if e["direction"] == "in" and e["category_kind"] != "expense":
            in_cents += e["cents"]
            continue
        # money out, or a refund netting against it
        cents = e["cents"] if e["direction"] == "out" else -e["cents"]
        part = "fixed" if e["is_recurring"] else "flexible"
        bucket = "none" if e["bucket"] is None else e["bucket"]
        parts[part][bucket] += cents
        cat = by_category.setdefault(
            e["category_id"],
            {
                "category_id": e["category_id"],
                "bucket": e["bucket"],
                "fixed_cents": 0,
                "flexible_cents": 0,
            },
        )
        if cat["bucket"] != e["bucket"]:
            raise RuleError("invalid_bucket")
        cat[f"{part}_cents"] += cents
    fixed = sum(parts["fixed"].values())
    flexible = sum(parts["flexible"].values())
    kept = in_cents - fixed - flexible
    categories = [
        {**c, "out_cents": c["fixed_cents"] + c["flexible_cents"]} for c in by_category.values()
    ]
    categories.sort(key=lambda c: _category_order(c, "out_cents"))
    room = [
        {"category_id": c["category_id"], "flexible_cents": c["flexible_cents"]}
        for c in categories
        if c["bucket"] == "want" and c["flexible_cents"] > 0
    ]
    room.sort(key=lambda c: _category_order(c, "flexible_cents"))
    return {
        "start": first.isoformat(),
        "end": last.isoformat(),
        "in_cents": in_cents,
        "out_cents": fixed + flexible,
        "fixed_cents": fixed,
        "flexible_cents": flexible,
        "fixed_by_bucket": parts["fixed"],
        "flexible_by_bucket": parts["flexible"],
        "kept_cents": kept,
        "kept_rate_bps": money.ratio_bps(kept, in_cents) if in_cents else None,
        "by_category": categories,
        "room": room,
    }
