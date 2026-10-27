"""Server adapter for the shared `notify.decide` rule: UTC instants in, the user's local
wall-clock strings to the rule, UTC instants back. The rule itself lives in stackd_rules.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from stackd_rules import notify


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("UTC")


def to_local(at: datetime, tz: str) -> str:
    return at.astimezone(zone(tz)).strftime("%Y-%m-%dT%H:%M")


def from_local(local: str, tz: str) -> datetime:
    return datetime.strptime(local, "%Y-%m-%dT%H:%M").replace(tzinfo=zone(tz)).astimezone(UTC)


def decide(candidate: dict, settings: dict, prefs: dict, sent: dict, now_local: str) -> dict:
    return notify.decide(candidate, settings, prefs, sent, now_local)
