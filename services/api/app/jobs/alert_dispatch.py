"""Sends due alerts (docs/spec.md "Notifications": a scheduled job, no AI).

For every due row: the shared `notify.decide` rule says send, skip, defer (quiet hours), or
roll into a summary (daily max). A send goes to each of the user's live push subscriptions
with a fixed title, the generic label and the dedupe key as tag, and is logged so it never
repeats. Gone subscriptions (404 / 410) are revoked. Run by `stackd-api dispatch-alerts`.

The weekly recap can also go by email (fast-follow 6; `jobs/weekly_recap.py`). The email is
sent at the chosen time whenever the rule would send, defer or summarise the push: quiet hours
and the daily maximum are push limits, and the user picked this time themselves. A paused
account gets neither. The email is logged under its own key (`<key>:email` when a push goes
too) so it is never sent twice.

Low balance, milestones and group activity can be set to "one daily summary": the rule holds
them as summary rows until the chosen time, and they go out with any other summary rows as one
push.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.jobs import weekly_recap
from app.models.notification import AlertSchedule, NotificationLog, PushSubscription
from app.models.user import User
from app.rules_server import notify as notify_rules
from app.services import ops_alerts, push
from app.services.alerts import (
    SUMMARY_LABEL,
    SUMMARY_LABEL_ONE,
    TITLE,
    URLS,
    digest_times,
    ensure_settings,
    prefs_for,
    recap_channel,
)

log = logging.getLogger("stackd.alerts")


def _settings_dict(row, digest: dict[str, str]) -> dict:
    return {
        "digest": digest,
        "quiet_start": row.quiet_start,
        "quiet_end": row.quiet_end,
        "daily_max": row.daily_max,
        "paused_until": notify_rules.to_local(row.paused_until, row.timezone)
        if row.paused_until
        else None,
    }


def _sent_today(db: DbSession, user_id: uuid.UUID, now: datetime, tz: str) -> int:
    local_day = notify_rules.to_local(now, tz)[:10]
    start = notify_rules.from_local(f"{local_day}T00:00", tz)
    return int(
        db.scalar(
            select(func.count())
            .select_from(NotificationLog)
            .where(NotificationLog.user_id == user_id, NotificationLog.sent_at >= start)
        )
        or 0
    )


def _deliver(db: DbSession, user_id: uuid.UUID, payload: dict, now: datetime) -> int:
    """Push to every live subscription; returns how many accepted it."""
    delivered = 0
    for sub in db.scalars(
        select(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.revoked_at.is_(None)
        )
    ):
        try:
            status = push.deliver(push.decrypt_subscription(sub.payload_encrypted), payload)
        except Exception as exc:  # noqa: BLE001 - one bad endpoint must not stop the run
            # A systemic failure (a bad signing key raises for every subscription) must reach
            # a person: ops_alerts dedupes to one email an hour per kind and place.
            log.exception("push failed")
            ops_alerts.report("push_failed", "alert_dispatch", exc)
            continue
        if status in (404, 410):
            sub.revoked_at = now
        elif 200 <= status < 300:
            sub.last_used_at = now
            delivered += 1
    return delivered


def dispatch_due(db: DbSession, *, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    counts = {"sent": 0, "email": 0, "summary": 0, "skipped": 0, "deferred": 0, "waiting": 0}
    rows = db.scalars(
        select(AlertSchedule)
        .where(
            AlertSchedule.status.in_(("pending", "deferred", "summary")),
            AlertSchedule.due_at <= now,
        )
        .order_by(AlertSchedule.user_id, AlertSchedule.due_at, AlertSchedule.id)
    ).all()
    by_user: dict[uuid.UUID, list[AlertSchedule]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(row)
    deleted = set(
        db.scalars(select(User.id).where(User.id.in_(by_user), User.deleted_at.is_not(None)))
    )
    for user_id, user_rows in by_user.items():
        if user_id in deleted:  # a deleted account hears nothing more (October 28, 2026)
            for r in user_rows:
                r.status = "skipped"
            counts["skipped"] += len(user_rows)
            continue
        settings = ensure_settings(db, user_id)
        prefs = prefs_for(db, user_id)
        enabled = {kind: bool(p["enabled"]) for kind, p in prefs.items()}
        channel = recap_channel(prefs)
        digest = digest_times(prefs)
        tz = settings.timezone
        now_local = notify_rules.to_local(now, tz)
        sent_today = _sent_today(db, user_id, now, tz)
        keys = set(
            db.scalars(
                select(NotificationLog.dedupe_key).where(
                    NotificationLog.user_id == user_id,
                    NotificationLog.dedupe_key.in_([r.dedupe_key for r in user_rows]),
                )
            )
        )
        # Rows already rolled into a summary go out together as one push.
        summary_rows = [r for r in user_rows if r.status == "summary"]
        if summary_rows and not notify_rules.notify.in_quiet_hours(
            notify_rules.notify.parse_clock(now_local[11:16]),
            notify_rules.notify.parse_clock(settings.quiet_start),
            notify_rules.notify.parse_clock(settings.quiet_end),
        ):
            payload = {
                "title": TITLE,
                "body": SUMMARY_LABEL_ONE
                if len(summary_rows) == 1
                else SUMMARY_LABEL.format(n=len(summary_rows)),
                "tag": f"summary:{now_local[:10]}",
                "url": "/",
            }
            _deliver(db, user_id, payload, now)
            for r in summary_rows:
                r.status = "sent"
                db.add(
                    NotificationLog(
                        user_id=user_id,
                        type=r.type,
                        dedupe_key=r.dedupe_key,
                        sent_at=now,
                        channel="summary",
                    )
                )
            counts["summary"] += len(summary_rows)
            sent_today += 1
            user_rows = [r for r in user_rows if r.status != "sent"]
        for row in user_rows:
            if row.status == "summary":
                continue
            decision = notify_rules.decide(
                {
                    "type": row.type,
                    "dedupe_key": row.dedupe_key,
                    "due_local": notify_rules.to_local(row.due_at, tz),
                },
                _settings_dict(settings, digest),
                enabled,
                {"keys": sorted(keys), "today": sent_today},
                now_local,
            )
            action = decision["action"]
            if row.type == "weekly_recap" and channel in ("email", "both"):
                # The email part: at the chosen time, whatever the push limits say.
                if action in ("send", "defer", "summary"):
                    email_key = row.dedupe_key if channel == "email" else f"{row.dedupe_key}:email"
                    if weekly_recap.send_email(db, user_id, email_key, now):
                        keys.add(email_key)
                        counts["email"] += 1
                    if channel == "email":
                        row.status = "sent"
                        continue
                elif action == "skip" and channel == "email":
                    row.status = "skipped"
                    counts["skipped"] += 1
                    continue
            if action == "send":
                payload = {
                    "title": TITLE,
                    "body": row.generic_label,
                    "tag": row.dedupe_key,
                    "url": URLS.get(row.type, "/"),
                }
                _deliver(db, user_id, payload, now)
                db.add(
                    NotificationLog(
                        user_id=user_id,
                        type=row.type,
                        dedupe_key=row.dedupe_key,
                        sent_at=now,
                        channel="push",
                    )
                )
                keys.add(row.dedupe_key)
                row.status = "sent"
                sent_today += 1
                counts["sent"] += 1
            elif action == "skip":
                row.status = "skipped"
                counts["skipped"] += 1
            elif action == "defer":
                row.status = "deferred"
                row.due_at = notify_rules.from_local(decision["send_at_local"], tz)
                counts["deferred"] += 1
            elif action == "summary":
                row.status = "summary"
                row.due_at = notify_rules.from_local(decision["send_at_local"], tz)
                counts["summary"] += 1
            else:
                counts["waiting"] += 1
        db.flush()
    db.commit()
    return counts


def retention_cutoff(now: datetime) -> datetime:
    return now - timedelta(days=90)
