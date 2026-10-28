"""Trials and plan ends (owner decision, October 14, 2026). Run hourly by `jobs-loop`.

- The day before a free trial or a cancelled plan ends (plans.yaml `reminder_days_before`):
  one "ends on …" email with a link to choose a plan (users.ending_notice_for remembers
  which end date it was for); for a trial, one push beside it with fixed words.
- A Founding term (owner decision, October 28, 2026): an email and a push 30, 7 and 1 day
  before it ends (plans.yaml `founding.reminder_days_before`; the last one sent is kept in
  subscriptions.founding_reminded_days, so each goes once), then "ended" on the day.
- When it has ended with no subscription: a friendly "your trial (or plan) has wrapped up"
  email (Founding's own on the day it ends), then one
  reminder a day for the rest of the 7 days (users.lapsed_notice_for, lapsed_reminded_on), each
  with the fixed push to devices that allowed alerts (October 20, 2026).
- An inbox that may not buy again (a payment the bank flagged as fraud, refunded in full,
  October 25, 2026) gets one honest note instead (the bank returned the payment; download your
  data; the closing date), no daily reminders, and a closing email that doesn't invite signing
  up again. A lost dispute is never here: its account is `ended` and stays open (owner).
- Seven days later: the account is closed through `deletion.soft_delete(plan_ended=True)`, and
  a last email says so; devices keep what they hold until the person decides (not erased).
Emails carry a link and dates, never amounts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.billing import Subscription
from app.models.user import User
from app.rules_server.entitlements import (
    access,
    active_subscription,
    load_plans,
    trial_settings,
)
from app.security.audit import AuditAction, record
from app.services import email, ops_alerts
from app.services.alerts import (
    FOUNDING_ENDED_LABEL,
    FOUNDING_ENDS_SOON_LABEL,
    PLAN_ENDED_LABEL,
    TRIAL_ENDS_TOMORROW_LABEL,
)
from app.services.deletion import soft_delete
from app.services.email import plan_link
from app.services.stripe_billing import is_blocked


def _day(when: datetime) -> str:
    return f"{when:%B} {when.day}, {when.year}"


def _ending(db: DbSession, user: User, now: datetime) -> tuple[datetime, bool] | None:
    """The end coming up for this account (trial or cancelled paid plan), if any."""
    state = access(db, user, now=now)
    if state["state"] == "trial":
        return state["trial_ends_at"], True
    sub = active_subscription(db, user.id, now=now)
    if sub is not None and sub.status == "canceled" and sub.ends_at is not None:
        return sub.ends_at, False
    if sub is not None and sub.cancel_at_period_end and sub.renews_at is not None:
        return sub.renews_at, False
    return None


def _push(
    db: DbSession,
    user_id: uuid.UUID,
    now: datetime,
    *,
    body: str = PLAN_ENDED_LABEL,
    tag: str = "plan-ended",
) -> None:
    """The same fixed words to every device that allowed alerts; no amounts, no dates."""
    from app.jobs import alert_dispatch  # noqa: PLC0415 - keeps the job imports light

    alert_dispatch._deliver(
        db, user_id, {"title": "Qash", "body": body, "tag": tag, "url": "/me/plan"}, now
    )


def run(
    db: DbSession, *, now: datetime | None = None, only: set[uuid.UUID] | None = None
) -> dict[str, int]:
    """`only` limits the run to some accounts (tests)."""
    now = now or datetime.now(UTC)
    before = timedelta(days=int(trial_settings()["reminder_days_before"]))
    counts = {"ending_soon": 0, "ended": 0, "reminded": 0, "deleted": 0}
    candidates = {
        *db.scalars(select(User.id).where(User.deleted_at.is_(None), User.trial_plan.is_not(None))),
        *db.scalars(select(Subscription.user_id).distinct()),
    }
    sender = email.get_sender()
    for user_id in sorted(candidates if only is None else candidates & only):
        # Each account on its own (October 28, 2026): a failure (an email refused, a database
        # error) rolls back only that account's stamps, to be tried again next hour, and each
        # account is committed once its emails went, so a later failure never re-sends them.
        try:
            with db.begin_nested():
                _one(db, user_id, now, before, sender, counts)
            db.commit()
        except Exception as exc:  # noqa: BLE001 - reported, and the run goes on
            db.rollback()
            ops_alerts.report("plan_lifecycle_failed", "plan_lifecycle.run", exc)
    return counts


def _one(
    db: DbSession,
    user_id: uuid.UUID,
    now: datetime,
    before: timedelta,
    sender: email.EmailSender,
    counts: dict[str, int],
) -> None:
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        return
    sub = active_subscription(db, user.id, now=now)
    if sub is not None and sub.plan == "founding" and sub.ends_at is not None:
        _founding_reminder(db, user, sub, now, sender, counts)
        return
    ending = _ending(db, user, now)
    if ending is not None:
        end, trial = ending
        if end - now <= before and user.ending_notice_for != end:
            sender.send(email.plan_ending_message(user.email, _day(end), plan_link(), trial))
            if trial:
                # Beside the email, once (owner, October 28, 2026); nothing daily in a trial.
                _push(db, user.id, now, body=TRIAL_ENDS_TOMORROW_LABEL, tag="trial-ends")
            user.ending_notice_for = end
            counts["ending_soon"] += 1
        return
    state = access(db, user, now=now)
    if state["state"] != "lapsed":
        return
    ended, delete_at = state["ended_at"], state["delete_at"]
    # The payment was refunded as possible fraud and this inbox may not buy again: honest
    # notes with no "keep going" (October 25, 2026).
    blocked = is_blocked(db, user)
    if now >= delete_at:
        address = user.email
        record(db, actor_id=user.id, action=AuditAction.DELETE_REQUESTED, target="plan_lapsed")
        soft_delete(db, user, now=now, plan_ended=True)
        sender.send(email.account_deleted_after_plan_message(address, welcome_back=not blocked))
        counts["deleted"] += 1
    elif user.lapsed_notice_for != ended:
        if blocked:
            sender.send(email.plan_ended_payment_returned_message(user.email, _day(delete_at)))
        elif _founding_ended(db, user, ended):
            sender.send(email.founding_ended_message(user.email, _day(delete_at), plan_link()))
        else:
            trial = user.trial_ends_at is not None and user.trial_ends_at == ended
            sender.send(
                email.plan_ended_message(user.email, _day(delete_at), plan_link(), trial=trial)
            )
        user.lapsed_notice_for = ended
        user.lapsed_reminded_on = now.date()
        if not blocked and _founding_ended(db, user, ended):
            _push(db, user.id, now, body=FOUNDING_ENDED_LABEL, tag="founding-ended")
        else:
            _push(db, user.id, now)
        counts["ended"] += 1
    elif not blocked and user.lapsed_reminded_on != now.date():
        # One friendly note a day for the rest of the 7 days (owner, October 20, 2026).
        days_left = max(1, -(-int((delete_at - now).total_seconds()) // 86400))
        sender.send(
            email.plan_lapsed_reminder_message(user.email, _day(delete_at), days_left, plan_link())
        )
        user.lapsed_reminded_on = now.date()
        _push(db, user.id, now)
        counts["reminded"] += 1


def _founding_reminder(
    db: DbSession,
    user: User,
    sub: Subscription,
    now: datetime,
    sender: email.EmailSender,
    counts: dict[str, int],
) -> None:
    """The reminder due now for a Founding term that is ending, once each: only the nearest
    stage, so a run that missed one (an outage) never sends two at once."""
    assert sub.ends_at is not None
    left = sub.ends_at - now
    due = [d for d in load_plans()["founding"]["reminder_days_before"] if left <= timedelta(days=d)]
    if not due:
        return
    stage = int(min(due))
    if sub.founding_reminded_days is not None and sub.founding_reminded_days <= stage:
        return
    sender.send(
        email.founding_ending_message(
            user.email, _day(sub.ends_at), plan_link(), tomorrow=left <= timedelta(days=1)
        )
    )
    _push(db, user.id, now, body=FOUNDING_ENDS_SOON_LABEL, tag="founding-ends")
    sub.founding_reminded_days = stage
    counts["ending_soon"] += 1


def _founding_ended(db: DbSession, user: User, ended: datetime) -> bool:
    """Whether the end the account is in is a Founding term's."""
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id == user.id,
                Subscription.plan == "founding",
                Subscription.ends_at == ended,
            )
        )
        is not None
    )
