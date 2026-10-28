"""Notification send rule (docs/spec.md "Notifications", "Rules added for custom goals and
notifications"): trigger true AND type enabled AND outside quiet hours AND under the daily max
AND dedupe key unused; over the max → the next summary. Paused → nothing until the pause ends.
A type the user set to "one daily summary" (`settings.digest`: type → "HH:MM") never goes out
on its own: it joins that day's summary at the chosen time, or tomorrow's once the time passed.

Times are the user's local wall-clock as "YYYY-MM-DDTHH:MM" strings; the server converts from
UTC with the user's time zone before calling this. Security alerts never pass through here.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from .errors import RuleError
from .money import _int

TYPES = (
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "group_activity",
    "weekly_recap",
)
_LOCAL = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")
_CLOCK = re.compile(r"[0-9]{2}:[0-9]{2}")


def parse_local(value: object) -> datetime:
    if not isinstance(value, str) or not _LOCAL.fullmatch(value):
        raise RuleError("invalid_time")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError as exc:
        raise RuleError("invalid_time") from exc


def parse_clock(value: object) -> int:
    """ "21:00" -> minutes since midnight."""
    if not isinstance(value, str) or not _CLOCK.fullmatch(value):
        raise RuleError("invalid_time")
    hours, minutes = int(value[:2]), int(value[3:])
    if hours > 23 or minutes > 59:
        raise RuleError("invalid_time")
    return hours * 60 + minutes


def fmt_local(value: datetime) -> str:
    return value.isoformat(timespec="minutes")  # strftime("%Y") skips the zero pad on glibc


def in_quiet_hours(minute_of_day: int, start: int, end: int) -> bool:
    if start == end:
        return False
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end  # spans midnight


def quiet_end_after(now: datetime, start: int, end: int) -> datetime:
    """The next moment quiet hours end, from a time that is inside them."""
    candidate = now.replace(hour=end // 60, minute=end % 60, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def decide(
    candidate: object, settings: object, prefs: object, sent: object, now_local: str
) -> dict:
    if not isinstance(candidate, dict) or candidate.get("type") not in TYPES:
        raise RuleError("invalid_candidate")
    key = candidate.get("dedupe_key")
    if not isinstance(key, str) or not key:
        raise RuleError("invalid_candidate")
    due = parse_local(candidate.get("due_local"))
    now = parse_local(now_local)
    if not isinstance(settings, dict) or not isinstance(prefs, dict):
        raise RuleError("invalid_settings")
    # A switch is on or off: only true and false, never a truthy 1 or "yes" (the device's engine
    # would read those differently), and a type left out is off.
    if any(not isinstance(on, bool) for on in prefs.values()):
        raise RuleError("invalid_settings")
    quiet_start = parse_clock(settings.get("quiet_start"))
    quiet_end = parse_clock(settings.get("quiet_end"))
    daily_max = _int(settings.get("daily_max"))
    if daily_max < 0:
        raise RuleError("invalid_settings")
    paused_until = settings.get("paused_until")
    paused = parse_local(paused_until) if paused_until is not None else None
    digest = settings.get("digest", {})
    if not isinstance(digest, dict) or any(k not in TYPES for k in digest):
        raise RuleError("invalid_settings")
    digest_at = digest.get(candidate["type"])
    digest_minute = parse_clock(digest_at) if digest_at is not None else None
    if not isinstance(sent, dict):
        raise RuleError("invalid_sent")
    sent_keys = sent.get("keys")
    if not isinstance(sent_keys, list) or any(not isinstance(k, str) for k in sent_keys):
        raise RuleError("invalid_sent")
    sent_today = _int(sent.get("today"))
    if sent_today < 0:
        raise RuleError("invalid_sent")

    if key in sent_keys:
        return {"action": "skip", "reason": "duplicate", "send_at_local": None}
    if prefs.get(candidate["type"]) is not True:
        return {"action": "skip", "reason": "disabled", "send_at_local": None}
    if due > now:
        return {"action": "wait", "reason": "not_due", "send_at_local": fmt_local(due)}
    if paused is not None and paused > now:
        return {"action": "skip", "reason": "paused", "send_at_local": None}
    minute = now.hour * 60 + now.minute
    if digest_minute is not None:
        at = now.replace(hour=digest_minute // 60, minute=digest_minute % 60)
        if minute > digest_minute:
            at += timedelta(days=1)
        return {"action": "summary", "reason": "daily_digest", "send_at_local": fmt_local(at)}
    if in_quiet_hours(minute, quiet_start, quiet_end):
        return {
            "action": "defer",
            "reason": "quiet_hours",
            "send_at_local": fmt_local(quiet_end_after(now, quiet_start, quiet_end)),
        }
    if daily_max > 0 and sent_today >= daily_max:
        # Extras roll into one summary at the start of the next day (after quiet hours).
        tomorrow = (now + timedelta(days=1)).replace(
            hour=quiet_end // 60, minute=quiet_end % 60, second=0, microsecond=0
        )
        return {"action": "summary", "reason": "daily_max", "send_at_local": fmt_local(tomorrow)}
    return {"action": "send", "reason": "ok", "send_at_local": fmt_local(now)}
