"""Goals: save, pay off, spend less, habit (docs/spec.md "Goals & challenges", "Calculation rules").

Save progress        (sum(deposits) − sum(withdrawals)) ÷ target; a withdrawal is money moved to
                     another jar (fast-follow 3). Display is capped at 100%; the true value is kept.
Payoff progress      (start balance − latest balance) ÷ start balance; a balance going up can
                     lower progress.
Spend-less progress  baseline − period spend in the category, against the amount to save.
Habit progress       days checked in ÷ streak length; one check-in per calendar day.
Weekly pace          (target − current) ÷ ceil(days left ÷ 7); past the deadline → overdue.
Spend-less baseline  the user's estimate in month 1, then the mean of the last 3 months.

Events are passed in; nothing is read. All amounts are integer cents.
"""

from __future__ import annotations

from datetime import date

from . import dates, money
from .errors import RuleError
from .money import _int

KINDS = ("save", "payoff", "spend_less", "habit")
EVENT_TYPES = ("deposit", "withdrawal", "balance_update", "checkin")


def _events(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_events")
    out = []
    for i, e in enumerate(raw):
        if not isinstance(e, dict) or e.get("type") not in EVENT_TYPES:
            raise RuleError("invalid_event")
        day = dates.parse_date(e.get("date"))
        amount = e.get("amount_cents")
        if e["type"] == "checkin":
            if amount is not None:
                raise RuleError("invalid_event")
        else:
            amount = _int(amount)
            if amount < 0:
                raise RuleError("invalid_amount")
        out.append({"type": e["type"], "date": day, "amount_cents": amount, "order": i})
    return out


def _weekly_pace(remaining: int, days_left: int | None) -> tuple[int | None, int | None]:
    """(weeks_left, cents or days per week) for what is still to do; None without a deadline."""
    if days_left is None:
        return None, None
    weeks = max(1, -(-days_left // 7))  # ceil, never 0
    return weeks, money.round_div(remaining, weeks)


def progress(goal: dict, events: list, as_of: str) -> dict:
    if not isinstance(goal, dict) or goal.get("kind") not in KINDS:
        raise RuleError("invalid_goal")
    kind = goal["kind"]
    today = dates.parse_date(as_of)
    start = dates.parse_date(goal.get("start_date"))
    end: date | None = (
        dates.parse_date(goal["end_date"]) if goal.get("end_date") is not None else None
    )
    if end is not None and end < start:
        raise RuleError("invalid_goal")
    rows = _events(events)

    if kind == "habit":
        target = _int(goal.get("target_days"))
        if target <= 0:
            raise RuleError("invalid_goal")
        if end is None:
            end = dates.add_days(start, target - 1)
        checked = {e["date"] for e in rows if e["type"] == "checkin" and start <= e["date"] <= end}
        current = len(checked)
    else:
        target = _int(goal.get("target_cents"))
        if target <= 0:
            raise RuleError("invalid_goal")
        if kind == "save":
            current = sum(e["amount_cents"] for e in rows if e["type"] == "deposit") - sum(
                e["amount_cents"] for e in rows if e["type"] == "withdrawal"
            )
        elif kind == "payoff":
            updates = sorted(
                (e for e in rows if e["type"] == "balance_update"),
                key=lambda e: (e["date"], e["order"]),
            )
            latest = updates[-1]["amount_cents"] if updates else target
            current = target - latest
        else:  # spend_less
            baseline = _int(goal.get("baseline_cents"))
            spent = _int(goal.get("period_spend_cents"))
            current = baseline - spent

    days_left = dates.days_until(today, end) if end is not None else None
    reached = current >= target
    remaining = max(0, target - current)
    weeks_left, pace = _weekly_pace(remaining, days_left)
    progress_bps = money.ratio_bps(current, target)
    return {
        "kind": kind,
        "current": current,
        "target": target,
        "remaining": remaining,
        "progress_bps": progress_bps,
        "display_bps": max(0, min(10000, progress_bps or 0)),
        "days_left": days_left,
        "weeks_left": weeks_left,
        "weekly_pace": pace if not reached else 0,
        "status": "reached"
        if reached
        else ("overdue" if days_left is not None and days_left < 0 else "active"),
        "end_date": end.isoformat() if end is not None else None,
    }


def spend_less_baseline(estimate_cents: int, previous_months_cents: list) -> int:
    """Month 1 uses the user's estimate; from then on, the mean of the last three months."""
    estimate = _int(estimate_cents)
    if estimate < 0:
        raise RuleError("invalid_amount")
    if not isinstance(previous_months_cents, list):
        raise RuleError("invalid_history")
    history = [_int(v) for v in previous_months_cents]
    if any(v < 0 for v in history):
        raise RuleError("invalid_amount")
    if not history:
        return estimate
    recent = history[-3:]
    return money.round_div(sum(recent), len(recent))
