"""Device-side alert schedule (docs/spec.md "Notifications"): which alerts are due in the next
30 days, computed from the device's own data, so the server only ever learns a date, a type
and a dedupe key. Nothing here carries an amount or a merchant.

- upcoming_expense  an unmatched expected bill, `lead_days` before its date,
                    at `time` (09:00 unless the person picks one)
- shortfall_risk    once per change in the forecast (keyed by the first short date and a tag of
                    the amount: FNV-1a 64 over its decimal digits, one letter a-p per hex
                    digit, so the key changes with the amount and carries no amount)
- challenge_checkin daily at the chosen time while a challenge runs
- goal_behind_pace  expected-by-now − saved ≥ periods × weekly pace (weekly pace = target ÷
                    weeks in the goal); keyed by the goal and the week
- milestone_reached as the device reports them (keyed by goal and milestone)
- weekly_recap      the chosen weekday and time, next occurrence
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from . import dates, money
from .errors import RuleError
from .fingerprint import fnv1a_64
from .money import _int
from .notify import fmt_local, parse_clock, parse_local

HORIZON_DAYS = 30
SEND_TIME = "09:00"  # dated alerts, unless the person picks their own time (`time`)


def _at(day: date, clock: str) -> datetime:
    minutes = parse_clock(clock)
    return datetime(day.year, day.month, day.day, minutes // 60, minutes % 60)


def amount_tag(cents: int) -> str:
    """16 letters a-p from FNV-1a 64 of the amount's decimal digits: a different amount gives a
    different key, and the key the server sees has no digits of the amount in it."""
    return "".join(chr(ord("a") + int(c, 16)) for c in f"{fnv1a_64(str(cents).encode()):016x}")


def _pref(prefs: dict, name: str) -> dict:
    p = prefs.get(name)
    if p is None:
        return {"enabled": False}
    if not isinstance(p, dict) or not isinstance(p.get("enabled"), bool):
        raise RuleError("invalid_prefs")
    return p


def _list(value: object) -> list:
    """A list, or none at all; anything else is invalid_inputs (never iterated as text)."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise RuleError("invalid_inputs")
    return value


def _flag(value: object) -> bool:
    """A yes / no field: true, false, or left out; a truthy 1 or [] is invalid_inputs."""
    if value is None:
        return False
    if not isinstance(value, bool):
        raise RuleError("invalid_inputs")
    return value


def schedule(inputs: object) -> dict:
    if not isinstance(inputs, dict):
        raise RuleError("invalid_inputs")
    now = parse_local(inputs.get("now_local"))
    today = now.date()
    horizon = today + timedelta(days=HORIZON_DAYS)
    prefs = inputs.get("prefs")
    if not isinstance(prefs, dict):
        raise RuleError("invalid_prefs")
    out: list[dict] = []

    def add(kind: str, due: datetime, key: str) -> None:
        if today <= due.date() <= horizon:
            out.append({"type": kind, "due_local": fmt_local(due), "dedupe_key": key})

    up = _pref(prefs, "upcoming_expense")
    if up["enabled"]:
        lead = _int(up.get("lead_days", 3))
        if lead < 0:
            raise RuleError("invalid_prefs")
        for item in _list(inputs.get("upcoming")):
            if (
                not isinstance(item, dict)
                or item.get("kind") != "bill"
                or _flag(item.get("matched"))
            ):
                continue
            when = dates.parse_date(item.get("date"))
            series = item.get("series_id")
            if not isinstance(series, str):
                raise RuleError("invalid_inputs")
            due = _at(when - timedelta(days=lead), up.get("time", SEND_TIME))
            if due < now:
                due = now
            add("upcoming_expense", due, f"upcoming:{series}:{when.isoformat()}")

    short = inputs.get("shortfall")
    if _pref(prefs, "shortfall_risk")["enabled"] and short is not None:
        if not isinstance(short, dict):
            raise RuleError("invalid_inputs")
        first = dates.parse_date(short.get("first_short_date"))
        cents = _int(short.get("short_by_cents"))
        add("shortfall_risk", now, f"shortfall:{first.isoformat()}:{amount_tag(cents)}")

    chk = _pref(prefs, "challenge_checkin")
    if chk["enabled"]:
        clock = chk.get("time", "19:30")
        for ch in _list(inputs.get("challenges")):
            if not isinstance(ch, dict) or not isinstance(ch.get("group_id"), str):
                raise RuleError("invalid_inputs")
            end = dates.parse_date(ch.get("end_date"))
            day = today
            while day <= min(end, horizon):
                due = _at(day, clock)
                if due >= now:
                    add("challenge_checkin", due, f"checkin:{ch['group_id']}:{day.isoformat()}")
                day += timedelta(days=1)

    behind = _pref(prefs, "goal_behind_pace")
    if behind["enabled"]:
        periods = _int(behind.get("periods", 1))
        if periods < 1:
            raise RuleError("invalid_prefs")
        for g in _list(inputs.get("goals")):
            if not isinstance(g, dict) or not isinstance(g.get("id"), str):
                raise RuleError("invalid_inputs")
            start = dates.parse_date(g.get("start_date"))
            end = dates.parse_date(g.get("end_date"))
            target = _int(g.get("target_cents"))
            current = _int(g.get("current_cents"))
            if end <= start or target <= 0 or today < start:
                continue
            weeks_total = max(1, -(-(end - start).days // 7))
            pace = money.round_div(target, weeks_total)
            weeks_elapsed = (today - start).days // 7
            expected = min(target, pace * weeks_elapsed)
            if expected - current >= periods * pace and pace > 0:
                add("goal_behind_pace", now, f"behind:{g['id']}:{weeks_elapsed}")

    if _pref(prefs, "milestone_reached")["enabled"]:
        for m in _list(inputs.get("milestones")):
            if not isinstance(m, dict) or not isinstance(m.get("goal_id"), str):
                raise RuleError("invalid_inputs")
            if not isinstance(m.get("key"), str):
                raise RuleError("invalid_inputs")
            add("milestone_reached", now, f"milestone:{m['goal_id']}:{m['key']}")

    recap = _pref(prefs, "weekly_recap")
    if recap["enabled"]:
        weekday = _int(recap.get("day", 0))  # 0 = Sunday … 6 = Saturday
        if not 0 <= weekday <= 6:
            raise RuleError("invalid_prefs")
        clock = recap.get("time", "09:00")
        day = today
        for _ in range(8):
            if (day.weekday() + 1) % 7 == weekday:
                due = _at(day, clock)
                if due >= now:
                    add("weekly_recap", due, f"recap:{day.isoformat()}")
                    break
            day += timedelta(days=1)

    out.sort(key=lambda a: (a["due_local"], a["type"], a["dedupe_key"]))
    return {"alerts": out}
