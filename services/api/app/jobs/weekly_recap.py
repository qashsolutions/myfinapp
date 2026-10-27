"""The weekly recap by email (fast-follow 6; the spec's "Push, email, both, or off").

The device registers its next recap as a push through `alerts.schedule`; email is the server's
job, because the device cannot send one. `enqueue_due` reads every weekly-recap preference set
to email or both and schedules the next occurrence in the user's zone under the same
`recap:<date>` key the device uses, so the two never double up. `alert_dispatch.dispatch_due`
sends the email once the row is due. The message carries a link and no numbers: the server
has none.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.notification import AlertSchedule, NotificationLog, NotificationPref
from app.models.user import User
from app.rules_server import notify as notify_rules
from app.services import email
from app.services.alerts import enqueue, ensure_settings


def next_occurrence(now_local: str, weekday: int, clock: str) -> str:
    """The next local minute on `weekday` (0 = Sunday … 6) at `clock`, today if still ahead."""
    day = date.fromisoformat(now_local[:10])
    for _ in range(8):
        if (day.weekday() + 1) % 7 == weekday:
            due = f"{day.isoformat()}T{clock}"
            if due >= now_local:
                return due
        day += timedelta(days=1)
    raise ValueError("no occurrence within a week")  # unreachable: every weekday recurs


def enqueue_due(db: DbSession, *, now: datetime | None = None) -> int:
    """Schedule the next recap for everyone who wants it by email. Returns how many were new."""
    now = now or datetime.now(UTC)
    prefs = db.scalars(
        select(NotificationPref).where(
            NotificationPref.type == "weekly_recap",
            NotificationPref.enabled.is_(True),
            NotificationPref.channel.in_(("email", "both")),
        )
    ).all()
    count = 0
    for pref in prefs:
        settings = ensure_settings(db, pref.user_id)
        now_local = notify_rules.to_local(now, settings.timezone)
        weekday = int((pref.days or "0").split(",")[0])
        due_local = next_occurrence(now_local, weekday, pref.time_of_day or "09:00")
        key = f"recap:{due_local[:10]}"
        already = db.scalar(
            select(AlertSchedule.id).where(
                AlertSchedule.user_id == pref.user_id, AlertSchedule.dedupe_key == key
            )
        )
        if already is not None:
            continue
        due_at = notify_rules.from_local(due_local, settings.timezone)
        if enqueue(db, pref.user_id, "weekly_recap", due_at, key, from_device=False) is not None:
            count += 1
    db.commit()
    return count


def recap_link() -> str:
    """The app's recap screen; the first configured origin is the app itself."""
    return f"{get_settings().origins[0].rstrip('/')}/recap"


def send_email(db: DbSession, user_id: uuid.UUID, dedupe_key: str, now: datetime) -> bool:
    """One recap email per key; a deleted account gets nothing."""
    if db.scalar(
        select(NotificationLog.id).where(
            NotificationLog.user_id == user_id, NotificationLog.dedupe_key == dedupe_key
        )
    ):
        return False
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        return False
    email.get_sender().send(email.weekly_recap_message(user.email, recap_link()))
    db.add(
        NotificationLog(
            user_id=user_id,
            type="weekly_recap",
            dedupe_key=dedupe_key,
            sent_at=now,
            channel="email",
        )
    )
    db.flush()
    return True
