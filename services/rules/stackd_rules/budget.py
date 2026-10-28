"""Budgeting (docs/spec.md "Budgeting" and "Calculation rules").

50/30/20 targets   needs 50%, wants 30%, save + pay down 20% of take-home; the rounding
                   remainder goes to save.
Bucket spent       sum of this month's entries whose category maps to the bucket; entries
                   dated after as_of are excluded; transfers are excluded; a refund (money in
                   with an expense category) nets against its category.
Zero-based         left to assign = take-home − sum(planned lines); negative = over-assigned.
Kept this month    take-home − total spent month-to-date, floored at 0.
Monthly take-home  from a paycheck amount and its frequency, rounded half-even once.

Entries and lines are passed in with their category's bucket, so the rule stays pure.
"""

from __future__ import annotations

from . import dates, money
from .errors import RuleError
from .money import _int

BUCKETS = ("need", "want", "save")
METHODS = ("50_30_20", "zero_based")
FREQUENCIES = {"weekly": (52, 12), "biweekly": (26, 12), "semimonthly": (2, 1), "monthly": (1, 1)}
WEIGHTS_BPS = [5000, 3000, 2000]


def targets_50_30_20(take_home_cents: int) -> dict[str, int]:
    total = _int(take_home_cents)
    if total < 0:
        raise RuleError("invalid_amount")
    need, want, save = money.allocate(total, WEIGHTS_BPS, remainder_to=2)
    return {"need": need, "want": want, "save": save}


def targets_split(take_home_cents: int, split_bps: dict) -> dict[str, int]:
    """The person's own needs / wants / save split (owner, October 20, 2026: 50/30/20 is the
    suggestion, not a rule). Each share 0–10000 bps, all three summing to 10000; the rounding
    remainder goes to save, as in 50/30/20."""
    total = _int(take_home_cents)
    if total < 0:
        raise RuleError("invalid_amount")
    weights = _split(split_bps)
    need, want, save = money.allocate(total, weights, remainder_to=2)
    return {"need": need, "want": want, "save": save}


def _split(split_bps: object) -> list[int]:
    if not isinstance(split_bps, dict) or set(split_bps) != set(BUCKETS):
        raise RuleError("invalid_split")
    weights = [split_bps[b] for b in BUCKETS]
    if any(isinstance(w, bool) or not isinstance(w, int) or not 0 <= w <= 10000 for w in weights):
        raise RuleError("invalid_split")
    if sum(weights) != 10000:
        raise RuleError("invalid_split")
    return weights


def monthly_take_home(amount_cents: int, frequency: str) -> int:
    """Per-paycheck amount × paychecks per year ÷ 12, half-even."""
    amount = _int(amount_cents)
    if amount < 0:
        raise RuleError("invalid_amount")
    if not isinstance(frequency, str) or frequency not in FREQUENCIES:
        raise RuleError("invalid_frequency")
    per_year, per = FREQUENCIES[frequency]
    return money.round_div(amount * per_year, per)


def _bucket(value: object) -> str | None:
    if value is None:
        return None
    if value not in BUCKETS:
        raise RuleError("invalid_bucket")
    return value  # type: ignore[return-value]


def _entries(raw: object, start, end, as_of) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_entries")
    rows = []
    for e in raw:
        if not isinstance(e, dict):
            raise RuleError("invalid_entry")
        day = dates.parse_date(e.get("date"))
        cents = _int(e.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        if e.get("direction") not in ("in", "out"):
            raise RuleError("invalid_direction")
        if not isinstance(e.get("is_transfer"), bool):
            raise RuleError("invalid_entry")
        category = e.get("category_id")
        if category is not None and not isinstance(category, str):
            raise RuleError("invalid_category")
        bucket = _bucket(e.get("bucket"))
        if day < start or day > end or day > as_of or e["is_transfer"]:
            continue
        rows.append(
            {"cents": cents, "direction": e["direction"], "category_id": category, "bucket": bucket}
        )
    return rows


def _lines(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_lines")
    out = []
    seen: set[str] = set()
    for line in raw:
        if not isinstance(line, dict) or not isinstance(line.get("category_id"), str):
            raise RuleError("invalid_line")
        planned = _int(line.get("planned_cents"))
        if planned < 0:
            raise RuleError("invalid_amount")
        if line["category_id"] in seen:
            raise RuleError("duplicate_line")
        seen.add(line["category_id"])
        out.append(
            {
                "category_id": line["category_id"],
                "bucket": _bucket(line.get("bucket")),
                "planned_cents": planned,
            }
        )
    return out


def summary(
    as_of: str,
    method: str,
    take_home_cents: int,
    lines: list,
    entries: list,
    split_bps: dict | None = None,
) -> dict:
    """Planned vs spent per bucket and per category for the month that contains as_of.

    The bucket method ("50_30_20") plans by `split_bps` when given (the person's own split),
    else 50/30/20."""
    if method not in METHODS:
        raise RuleError("invalid_method")
    take_home = _int(take_home_cents)
    if take_home < 0:
        raise RuleError("invalid_amount")
    day = dates.parse_date(as_of)
    start, end = dates.month_bounds(day)
    planned_lines = _lines(lines)
    rows = _entries(entries, start, end, day)

    spent_by_category: dict[str, int] = {}
    bucket_of: dict[str, str | None] = {
        line["category_id"]: line["bucket"] for line in planned_lines
    }
    uncategorized = 0
    for r in rows:
        signed = r["cents"] if r["direction"] == "out" else -r["cents"]
        if r["direction"] == "in" and r["bucket"] is None:
            continue  # income, not spending
        if r["category_id"] is None:
            uncategorized += signed
            continue
        spent_by_category[r["category_id"]] = spent_by_category.get(r["category_id"], 0) + signed
        bucket_of.setdefault(r["category_id"], r["bucket"])

    if method == "50_30_20":
        targets = (
            targets_50_30_20(take_home)
            if split_bps is None
            else targets_split(take_home, split_bps)
        )
        planned_by_bucket = dict(targets)
        left_to_assign = None
    else:
        planned_by_bucket = {b: 0 for b in BUCKETS}
        for line in planned_lines:
            if line["bucket"] is not None:
                planned_by_bucket[line["bucket"]] += line["planned_cents"]
        left_to_assign = take_home - sum(line["planned_cents"] for line in planned_lines)

    spent_by_bucket = {b: 0 for b in BUCKETS}
    for category, cents in spent_by_category.items():
        bucket = bucket_of.get(category)
        if bucket is not None:
            spent_by_bucket[bucket] += cents
    planned_lookup = {line["category_id"]: line["planned_cents"] for line in planned_lines}
    category_ids = sorted(
        set(spent_by_category) | set(planned_lookup),
        key=lambda c: (-spent_by_category.get(c, 0), c),
    )
    total_spent = sum(spent_by_category.values()) + uncategorized
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "method": method,
        "take_home_cents": take_home,
        "buckets": [
            {
                "bucket": b,
                "planned_cents": planned_by_bucket[b],
                "spent_cents": spent_by_bucket[b],
                "left_cents": planned_by_bucket[b] - spent_by_bucket[b],
            }
            for b in BUCKETS
        ],
        "categories": [
            {
                "category_id": c,
                "bucket": bucket_of.get(c),
                "planned_cents": planned_lookup.get(c) if method == "zero_based" else None,
                "spent_cents": spent_by_category.get(c, 0),
            }
            for c in category_ids
        ],
        "uncategorized_cents": uncategorized,
        "total_spent_cents": total_spent,
        "left_to_assign_cents": left_to_assign,
        "kept_cents": max(0, take_home - total_spent),
    }
