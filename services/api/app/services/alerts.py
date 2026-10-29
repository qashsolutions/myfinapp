"""The alert schedule and the user's notification preferences.

The device computes which alerts are due (the `alerts.schedule` rule) and registers only a
date, a type and a dedupe key; the label is fixed text per type, chosen here. Group activity is
the one type the server schedules itself, because the server is where a member joins.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from importlib import resources

from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from app.models.group import Group
from app.models.group_member import GroupMember
from app.models.notification import (
    ALERT_TYPES,
    DIGEST_TYPES,
    AlertSchedule,
    NotificationLog,
    NotificationPref,
    NotificationSettings,
)

# Fixed lock-screen text per type, from the one catalog of messages
# (services/rules/stackd_rules/config/moments.yaml): never an amount, a merchant or a name.
_MOMENTS = json.loads(
    resources.files("stackd_rules").joinpath("config/moments.json").read_text(encoding="utf-8")
)
LABELS: dict[str, str] = {
    kind: event["push"] for kind, event in _MOMENTS["events"].items() if "push" in event
}
SUMMARY_LABEL: str = _MOMENTS["push_summary"]
SUMMARY_LABEL_ONE: str = _MOMENTS["push_summary_one"]
PLAN_ENDED_LABEL: str = _MOMENTS["push_plan_ended"]
TRIAL_ENDS_TOMORROW_LABEL: str = _MOMENTS["push_trial_ends_tomorrow"]
FOUNDING_ENDS_SOON_LABEL: str = _MOMENTS["push_founding_ends_soon"]
FOUNDING_ENDED_LABEL: str = _MOMENTS["push_founding_ended"]
BUDGET_REACHED_LABEL: str = _MOMENTS["push_budget_reached"]
TITLE = "Qash"
# Where a tap on the push lands (the service worker opens it); never a deep link with data.
URLS: dict[str, str] = {
    "upcoming_expense": "/forecast",
    "shortfall_risk": "/forecast",
    "challenge_checkin": "/goals",
    "goal_behind_pace": "/goals",
    "milestone_reached": "/goals",
    "group_activity": "/goals",
    "weekly_recap": "/recap",
    "budget_pace": "/budget",
}
# A budget alert key: the month, a 16-letter tag the device made from a random value it keeps
# and the category's id (never the category, its name or an amount), and the level in bps.
BUDGET_KEY = re.compile(r"budget:[0-9]{4}-[0-9]{2}:[a-p]{16}:([0-9]{1,6})")

DEFAULT_PREFS: dict[str, dict] = {
    "upcoming_expense": {"enabled": True, "lead_days": 3, "time_of_day": "09:00"},
    # delivery: instant, or "daily" for one summary at time_of_day (DIGEST_TYPES only)
    "shortfall_risk": {"enabled": True, "delivery": "instant", "time_of_day": "19:00"},
    "challenge_checkin": {"enabled": True, "time_of_day": "19:30"},
    "goal_behind_pace": {"enabled": True, "threshold": 1},
    "milestone_reached": {"enabled": True, "delivery": "instant", "time_of_day": "19:00"},
    "group_activity": {"enabled": False, "delivery": "instant", "time_of_day": "19:00"},
    # channel: push, email or both (docs/spec.md "Notifications": "Push, email, both, or off")
    "weekly_recap": {"enabled": True, "time_of_day": "09:00", "days": "0", "channel": "push"},
    # threshold: the "Tell me at" percent; none = the rules config's levels (90% and 100%)
    "budget_pace": {"enabled": True, "time_of_day": "09:00"},
}
MAX_SCHEDULE_ITEMS = 300


def label_for(kind: str, dedupe_key: str) -> str:
    """The fixed lock-screen text: per type, except a budget alert at its whole plan or more."""
    if kind == "budget_pace":
        match = BUDGET_KEY.fullmatch(dedupe_key)
        if match and int(match.group(1)) >= 10000:
            return BUDGET_REACHED_LABEL
    return LABELS[kind]


def recap_channel(prefs: dict[str, dict]) -> str:
    """push, email or both for the weekly recap (anything unknown counts as push)."""
    channel = prefs.get("weekly_recap", {}).get("channel")
    return channel if channel in ("push", "email", "both") else "push"


def digest_times(prefs: dict[str, dict]) -> dict[str, str]:
    """Types the user wants as one daily summary, with the local time it goes out."""
    return {
        kind: prefs[kind]["time_of_day"]
        for kind in DIGEST_TYPES
        if prefs.get(kind, {}).get("delivery") == "daily"
    }


def ensure_settings(db: DbSession, user_id: uuid.UUID) -> NotificationSettings:
    row = db.scalar(select(NotificationSettings).where(NotificationSettings.user_id == user_id))
    if row is None:
        row = NotificationSettings(user_id=user_id)
        db.add(row)
        db.flush()
    return row


def prefs_for(db: DbSession, user_id: uuid.UUID) -> dict[str, dict]:
    """Every type with the stored row's values over the defaults."""
    rows = {
        r.type: r
        for r in db.scalars(select(NotificationPref).where(NotificationPref.user_id == user_id))
    }
    out: dict[str, dict] = {}
    for kind in ALERT_TYPES:
        base = dict(DEFAULT_PREFS[kind])
        row = rows.get(kind)
        if row is not None:
            base["enabled"] = row.enabled
            if row.time_of_day is not None:
                base["time_of_day"] = row.time_of_day
            if row.days is not None:
                base["days"] = row.days
            if row.lead_days is not None:
                base["lead_days"] = row.lead_days
            if row.threshold is not None:
                base["threshold"] = row.threshold
            if row.channel is not None:
                base["channel"] = row.channel
            if row.delivery is not None:
                base["delivery"] = row.delivery
        out[kind] = base
    return out


def upsert_pref(db: DbSession, user_id: uuid.UUID, kind: str, values: dict) -> None:
    row = db.scalar(
        select(NotificationPref).where(
            NotificationPref.user_id == user_id, NotificationPref.type == kind
        )
    )
    if row is None:
        row = NotificationPref(user_id=user_id, type=kind)
        db.add(row)
    fields = ("enabled", "time_of_day", "days", "lead_days", "threshold", "channel", "delivery")
    for field in fields:
        if field in values and values[field] is not None:
            setattr(row, field, values[field])
    db.flush()


def enqueue(
    db: DbSession,
    user_id: uuid.UUID,
    kind: str,
    due_at: datetime,
    dedupe_key: str,
    *,
    from_device: bool,
    now: datetime | None = None,
) -> AlertSchedule | None:
    """One pending alert per (user, key); a key already sent or scheduled is left alone.

    A key that was skipped and never sent (the type was off, or alerts were paused, when it
    came due) is scheduled again when it arrives with a due time still ahead (invariant 34,
    October 29, 2026): turning the type back on brings its alerts back. A sent key never
    repeats: its log row answers first."""
    if db.scalar(
        select(NotificationLog.id).where(
            NotificationLog.user_id == user_id, NotificationLog.dedupe_key == dedupe_key
        )
    ):
        return None
    existing = db.scalar(
        select(AlertSchedule).where(
            AlertSchedule.user_id == user_id, AlertSchedule.dedupe_key == dedupe_key
        )
    )
    if existing is not None:
        if existing.status == "skipped" and due_at > (now or datetime.now(UTC)):
            existing.status = "pending"
            existing.due_at = due_at
            existing.type = kind
            existing.generic_label = label_for(kind, dedupe_key)
            existing.from_device = from_device
            db.flush()
        return existing
    row = AlertSchedule(
        user_id=user_id,
        due_at=due_at,
        type=kind,
        generic_label=label_for(kind, dedupe_key),
        dedupe_key=dedupe_key,
        from_device=from_device,
    )
    db.add(row)
    db.flush()
    return row


def replace_device_schedule(db: DbSession, user_id: uuid.UUID, items: list[dict]) -> int:
    """The device's whole upcoming list replaces what it registered before (sent rows stay)."""
    db.execute(
        delete(AlertSchedule).where(
            AlertSchedule.user_id == user_id,
            AlertSchedule.from_device.is_(True),
            AlertSchedule.status.in_(("pending", "deferred", "summary")),
        )
    )
    db.flush()
    count = 0
    for item in items:
        if enqueue(db, user_id, item["type"], item["due_at"], item["dedupe_key"], from_device=True):
            count += 1
    return count


def group_joined(
    db: DbSession, group: Group, joiner_id: uuid.UUID, now: datetime | None = None
) -> int:
    """Tell the other members someone joined (their group_activity preference decides)."""
    now = now or datetime.now(UTC)
    others = db.scalars(
        select(GroupMember.user_id).where(
            GroupMember.group_id == group.id,
            GroupMember.user_id != joiner_id,
            GroupMember.left_at.is_(None),
        )
    ).all()
    key = f"group:{group.id}:join:{joiner_id}:{now.date().isoformat()}"
    count = 0
    for user_id in others:
        if enqueue(db, user_id, "group_activity", now, f"{key}:{user_id}", from_device=False):
            count += 1
    return count
