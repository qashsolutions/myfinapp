"""Notifications (docs/spec.md "Notifications" and its data model): what the user allows, when
to stay quiet, where to push, what was sent, and the minimal schedule the device registers.

Nothing here carries an amount or a merchant: alert rows hold a date, a type, a fixed generic
label and a dedupe key. Push subscriptions are stored encrypted.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

ALERT_TYPES = (
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "group_activity",
    "weekly_recap",
    "budget_pace",
)
PLATFORMS = ("web", "ios", "android")
CHANNELS = ("push", "email", "summary")
RECAP_CHANNELS = ("push", "email", "both")  # how the weekly recap arrives (fast-follow 6)
DELIVERIES = ("instant", "daily")  # as it happens, or one daily summary
# The event alerts with no time of their own may wait for one daily summary instead.
DIGEST_TYPES = ("shortfall_risk", "milestone_reached", "group_activity")
STATUSES = ("pending", "deferred", "summary", "sent", "skipped")


def _one_of(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class NotificationPref(Base, StackdRow):
    __tablename__ = "notification_prefs"
    __table_args__ = (
        UniqueConstraint("user_id", "type"),
        CheckConstraint(_one_of("type", ALERT_TYPES), name="type"),
        CheckConstraint(_one_of("channel", RECAP_CHANNELS), name="channel"),
        CheckConstraint(_one_of("delivery", DELIVERIES), name="delivery"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(32))
    enabled: Mapped[bool] = mapped_column(default=True, server_default=true())
    time_of_day: Mapped[str | None] = mapped_column(String(5))  # "19:30"
    days: Mapped[str | None] = mapped_column(String(32))  # "0" = Sunday … "6", comma separated
    lead_days: Mapped[int | None] = mapped_column(Integer)
    # goal_behind_pace: periods behind; budget_pace: the "Tell me at" percent (50-150)
    threshold: Mapped[int | None] = mapped_column(Integer)
    channel: Mapped[str | None] = mapped_column(String(8))  # weekly_recap only; null = push
    # DIGEST_TYPES only; null = instant. "daily" sends one summary at time_of_day.
    delivery: Mapped[str | None] = mapped_column(String(8))


class NotificationSettings(Base, StackdRow):
    __tablename__ = "notification_settings"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    quiet_start: Mapped[str] = mapped_column(String(5), default="21:00", server_default="21:00")
    quiet_end: Mapped[str] = mapped_column(String(5), default="08:00", server_default="08:00")
    daily_max: Mapped[int] = mapped_column(Integer, default=3, server_default="3")
    paused_until: Mapped[datetime | None]
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", server_default="UTC")


class PushSubscription(Base, StackdRow):
    __tablename__ = "push_subscriptions"
    __table_args__ = (CheckConstraint(_one_of("platform", PLATFORMS), name="platform"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    platform: Mapped[str] = mapped_column(String(16), default="web", server_default="web")
    endpoint_hash: Mapped[str] = mapped_column(String(64), unique=True)
    payload_encrypted: Mapped[str] = mapped_column(Text)  # Fernet of {endpoint, keys}
    user_agent: Mapped[str | None] = mapped_column(String(120))
    last_used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]


class NotificationLog(Base, StackdRow):
    __tablename__ = "notification_log"
    __table_args__ = (
        # Per user: device keys are the same string for everyone ("recap:<date>"), so a global
        # unique constraint would let the first send suppress every other user's (migration 0010).
        UniqueConstraint("user_id", "dedupe_key"),
        CheckConstraint(_one_of("channel", CHANNELS), name="channel"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(32))
    dedupe_key: Mapped[str] = mapped_column(String(200))
    sent_at: Mapped[datetime]
    channel: Mapped[str] = mapped_column(String(16))


class AlertSchedule(Base, StackdRow):
    __tablename__ = "alert_schedule"
    __table_args__ = (
        UniqueConstraint("user_id", "dedupe_key"),
        CheckConstraint(_one_of("type", ALERT_TYPES), name="type"),
        CheckConstraint(_one_of("status", STATUSES), name="status"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    due_at: Mapped[datetime] = mapped_column(index=True)
    type: Mapped[str] = mapped_column(String(32))
    generic_label: Mapped[str] = mapped_column(String(80))
    dedupe_key: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    from_device: Mapped[bool] = mapped_column(default=True, server_default=true())


__all__ = [
    "ALERT_TYPES",
    "RECAP_CHANNELS",
    "AlertSchedule",
    "NotificationLog",
    "NotificationPref",
    "NotificationSettings",
    "PushSubscription",
]
_ = false  # keep the import for symmetry with other models
