"""Custom goals (docs/spec.md "Custom goals", "Rules added for custom goals and notifications").

Custom jar   name, amount, date (launch).
Plan         fast-follow 3: with a deadline, per-period amount = remaining ÷ periods left by
             cadence (payday cadence counts the user's pay dates); with a fixed per-period
             amount, finish date = today + ceil(remaining ÷ amount) periods; neither → needs
             an amount. `next_date` is the next deposit date (one period on, or the next payday).
Streak       ongoing goals: periods anchored at the start date; a period counts when its deposits
             reach the plan; the streak is the run of counted periods back from the latest
             complete one (the current period adds to it when already met); a period that
             overlaps a pause is skipped, never a break.
Milestones   checkpoints as basis points of the target (25% = 2500), reached when current ≥ each.

Custom jar   name trimmed of ASCII whitespace, 1..10 characters (owner decision, October 10,
             2026: short enough for every card and list); amount > 0;
             deadline today or later, or none. Pace comes from goals.progress with no events.
"""

from __future__ import annotations

from datetime import date

from . import dates, goals, money
from .errors import RuleError
from .money import _int

NAME_MAX = 10  # owner decision, October 10, 2026
_EDGE_WHITESPACE = " \t\r\n"  # ASCII only, so the TypeScript port trims the same characters


def jar(name: object, target_cents: object, end_date: object, as_of: str) -> dict:
    if not isinstance(name, str):
        raise RuleError("invalid_name")
    title = name.strip(_EDGE_WHITESPACE)
    if not title or len(title) > NAME_MAX:
        raise RuleError("invalid_name")
    target = _int(target_cents, "invalid_amount")
    if target <= 0:
        raise RuleError("invalid_amount")
    today = dates.parse_date(as_of)
    end = dates.parse_date(end_date) if end_date is not None else None
    if end is not None and end < today:
        raise RuleError("deadline_in_past")
    goal = {
        "kind": "save",
        "title": title,
        "target_cents": target,
        "start_date": today.isoformat(),
        "end_date": end.isoformat() if end is not None else None,
    }
    pace = goals.progress(goal, [], as_of)
    return {
        "goal": goal,
        "days_left": pace["days_left"],
        "weeks_left": pace["weeks_left"],
        "weekly_pace": pace["weekly_pace"],
    }


_CADENCE_DAYS = {"weekly": 7, "biweekly": 14}


def _step(day: date, cadence: str, k: int, schedule: object) -> date:
    """`day` moved `k` periods on; for payday cadence, the k-th payday after `day`."""
    if cadence in _CADENCE_DAYS:
        return dates.add_days(day, _CADENCE_DAYS[cadence] * k)
    if cadence == "monthly":
        return dates.add_months(day, k)
    if cadence == "payday":
        if schedule is None:
            raise RuleError("schedule_required")
        if k == 0:
            return day
        return dates.next_paydays(day, schedule, k)[-1]
    raise RuleError("invalid_cadence")


def plan(goal: object, events: object, as_of: str, schedule: object = None) -> dict:
    if not isinstance(goal, dict):
        raise RuleError("invalid_goal")
    cadence = goal.get("cadence")
    if cadence not in dates.CADENCES:
        raise RuleError("invalid_cadence")
    today = dates.parse_date(as_of)
    base = {
        k: v for k, v in goal.items() if k in ("kind", "target_cents", "start_date", "end_date")
    }
    progress = goals.progress(base, events, as_of)
    remaining = progress["remaining"]
    end = dates.parse_date(goal["end_date"]) if goal.get("end_date") is not None else None
    fixed = goal.get("per_period_cents")
    fixed_cents = _int(fixed, "invalid_amount") if fixed is not None else None
    if fixed_cents is not None and fixed_cents < 0:
        raise RuleError("invalid_amount")
    next_date = _step(today, cadence, 1, schedule)
    if end is not None:
        periods_left = dates.periods_until(today, end, cadence, schedule)
        return {
            "remaining_cents": remaining,
            "periods_left": periods_left,
            "per_period_cents": money.round_div(remaining, max(1, periods_left)),
            "finish_date": end.isoformat(),
            "next_date": next_date.isoformat(),
            "needs_amount": False,
        }
    if fixed_cents:
        periods_needed = -(-remaining // fixed_cents)  # ceil
        finish = _step(today, cadence, periods_needed, schedule) if periods_needed else today
        return {
            "remaining_cents": remaining,
            "periods_left": periods_needed,
            "per_period_cents": fixed_cents,
            "finish_date": finish.isoformat(),
            "next_date": next_date.isoformat(),
            "needs_amount": False,
        }
    return {
        "remaining_cents": remaining,
        "periods_left": None,
        "per_period_cents": None,
        "finish_date": None,
        "next_date": next_date.isoformat(),
        "needs_amount": True,
    }


def _pauses(raw: object) -> list[tuple[date, date | None]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError("invalid_pauses")
    out = []
    for p in raw:
        if not isinstance(p, dict):
            raise RuleError("invalid_pauses")
        start = dates.parse_date(p.get("start"))
        end = dates.parse_date(p["end"]) if p.get("end") is not None else None
        if end is not None and end < start:
            raise RuleError("invalid_pauses")
        out.append((start, end))
    return out


def streak(goal: object, events: object, as_of: str, schedule: object = None) -> dict:
    if not isinstance(goal, dict):
        raise RuleError("invalid_goal")
    cadence = goal.get("cadence")
    if cadence not in dates.CADENCES:
        raise RuleError("invalid_cadence")
    plan_cents = _int(goal.get("per_period_cents"), "invalid_amount")
    if plan_cents <= 0:
        raise RuleError("invalid_amount")
    today = dates.parse_date(as_of)
    start = dates.parse_date(goal.get("start_date"))
    if start > today:
        raise RuleError("invalid_goal")
    pauses = _pauses(goal.get("pauses"))
    rows = [e for e in goals._events(events) if e["type"] in ("deposit", "withdrawal")]
    total = sum(e["amount_cents"] if e["type"] == "deposit" else -e["amount_cents"] for e in rows)
    # Period boundaries from the start date up to the one after today.
    bounds = [start]
    k = 1
    while bounds[-1] <= today:
        nxt = _step(start, cadence, k, schedule)
        if nxt <= bounds[-1]:
            raise RuleError("invalid_schedule")
        bounds.append(nxt)
        k += 1
        if k > 1200:
            raise RuleError("invalid_schedule")
    periods = []
    for i in range(len(bounds) - 1):
        p_start, p_end = bounds[i], bounds[i + 1]
        saved = sum(
            e["amount_cents"] if e["type"] == "deposit" else -e["amount_cents"]
            for e in rows
            if p_start <= e["date"] < p_end
        )
        paused = any(ps < p_end and (pe is None or pe >= p_start) for ps, pe in pauses)
        periods.append(
            {
                "start": p_start.isoformat(),
                "end": p_end.isoformat(),
                "saved_cents": saved,
                "met": saved >= plan_cents,
                "paused": paused,
                "complete": p_end <= today,
            }
        )
    run = 0
    current = periods[-1]
    if current["met"] and not current["paused"]:
        run += 1
    for period in reversed(periods[:-1]):
        if period["paused"]:
            continue
        if not period["met"]:
            break
        run += 1
    return {
        "total_cents": total,
        "streak": run,
        "periods_complete": sum(1 for p in periods if p["complete"]),
        "current": {k: current[k] for k in ("start", "end", "saved_cents", "met", "paused")},
    }


def milestones(target_cents: object, current_cents: object, checkpoints_bps: object) -> dict:
    target = _int(target_cents, "invalid_amount")
    current = _int(current_cents, "invalid_amount")
    if target <= 0:
        raise RuleError("invalid_amount")
    if not isinstance(checkpoints_bps, list) or not checkpoints_bps:
        raise RuleError("invalid_checkpoints")
    out = []
    for bps in checkpoints_bps:
        value = _int(bps, "invalid_checkpoints")
        if not 0 < value <= 10000:
            raise RuleError("invalid_checkpoints")
        cents = money.pct_of(target, value)
        out.append({"bps": value, "target_cents": cents, "reached": current >= cents})
    return {"milestones": out}
