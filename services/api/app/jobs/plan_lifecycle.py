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

A household of two is one plan (owner decision, October 29, 2026; invariant 54): the partner the
holder's plan covers gets the same notices for that plan (ending soon, Founding's stages, ended,
the daily reminders), each saying it is the plan they share, and the same 7 days; the two
accounts close in the same run. Someone the shared plan stopped covering (they left, or its
holder did) gets the ended note for that and their own 7 days.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.billing import Subscription
from app.models.household import HouseholdMember
from app.models.user import User
from app.rules_server.entitlements import (
    access,
    active_subscription,
    household_pair,
    household_plan,
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
        # A household's partner may have no plan of their own (invariant 54).
        *db.scalars(select(HouseholdMember.user_id).where(HouseholdMember.left_at.is_(None))),
        *db.scalars(select(User.id).where(User.household_cover_ended_at.is_not(None))),
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
    found = household_plan(db, user, now=now)
    state = found.access
    shared = found.shared  # in a household of two: the notices say it's the plan they share
    if found.covered:
        assert found.holder_id is not None
        _covered_notices(db, user, found.holder_id, now, before, sender, counts)
        return
    sub = active_subscription(db, user.id, now=now)
    if sub is not None and sub.plan == "founding" and sub.ends_at is not None:
        _founding_reminder(db, user, sub, now, sender, counts, shared=shared)
        return
    ending = _ending(db, user, now)
    if ending is not None:
        end, trial = ending
        if end - now <= before and user.ending_notice_for != end:
            sender.send(
                email.plan_ending_message(user.email, _day(end), plan_link(), trial, shared=shared)
            )
            if trial:
                # Beside the email, once (owner, October 28, 2026); nothing daily in a trial.
                _push(db, user.id, now, body=TRIAL_ENDS_TOMORROW_LABEL, tag="trial-ends")
            user.ending_notice_for = end
            counts["ending_soon"] += 1
        return
    if state["state"] != "lapsed":
        return
    ended, delete_at = state["ended_at"], state["delete_at"]
    # The payment was refunded as possible fraud and this inbox may not buy again: honest
    # notes with no "keep going" (October 25, 2026).
    blocked = is_blocked(db, user)
    # The plan that ended: this person's own, or the one the household shared (its holder's).
    pair = household_pair(db, user.id)
    plan_of = [user.id, *(pair or ())]
    # The holder lost a dispute (owner decision, October 29, 2026): the one their plan covered
    # hears only that the plan that covered them ended, never about the dispute, and the notes
    # don't say it ends for both (the holder's account is `ended`, not lapsed).
    others = [u for u in pair or () if u != user.id]
    holder_lost = state.get("shared") == "covered" and _dispute_lost(db, others, ended)
    if holder_lost:
        shared = False
    # Never closed without the ended email for this end (invariant 68): an account whose end
    # moved later than its notice (a household's plan, read again) hears of it first.
    if now >= delete_at and user.lapsed_notice_for == ended:
        # Both accounts of a household close together (invariant 54): a partner whose 7 days
        # are over too goes in this run, read before this closing splits the household.
        together = [user]
        for other_id in pair or ():
            other = db.get(User, other_id)
            if other is None or other.id == user.id or other.deleted_at is not None:
                continue
            theirs = access(db, other, now=now)
            if (
                theirs["state"] == "lapsed"
                and now >= theirs["delete_at"]
                and other.lapsed_notice_for == theirs["ended_at"]
            ):
                together.append(other)
        for person in together:
            address, welcome_back = person.email, not is_blocked(db, person)
            record(
                db, actor_id=person.id, action=AuditAction.DELETE_REQUESTED, target="plan_lapsed"
            )
            soft_delete(db, person, now=now, plan_ended=True)
            sender.send(
                email.account_deleted_after_plan_message(
                    # "closed both accounts" only when both did close
                    address,
                    welcome_back=welcome_back,
                    shared=shared and len(together) > 1,
                )
            )
            counts["deleted"] += 1
    elif user.lapsed_notice_for != ended:
        left = user.household_cover_ended_at is not None and user.household_cover_ended_at == ended
        founding = _founding_ended(db, plan_of, ended)
        if blocked:
            sender.send(email.plan_ended_payment_returned_message(user.email, _day(delete_at)))
        elif holder_lost:
            sender.send(
                email.household_plan_ended_message(user.email, _day(delete_at), plan_link())
            )
        elif left and not shared:
            sender.send(
                email.household_cover_ended_message(
                    user.email, _day(delete_at), plan_link(), switched=pair is not None
                )
            )
        elif founding:
            sender.send(
                email.founding_ended_message(
                    user.email, _day(delete_at), plan_link(), shared=shared
                )
            )
        else:
            sender.send(
                email.plan_ended_message(
                    user.email,
                    _day(delete_at),
                    plan_link(),
                    trial=_trial_ended(db, plan_of, ended),
                    shared=shared,
                )
            )
        user.lapsed_notice_for = ended
        user.lapsed_reminded_on = now.date()
        if not blocked and founding:
            _push(db, user.id, now, body=FOUNDING_ENDED_LABEL, tag="founding-ended")
        else:
            _push(db, user.id, now)
        counts["ended"] += 1
    elif not blocked and user.lapsed_reminded_on != now.date():
        # One friendly note a day for the rest of the 7 days (owner, October 20, 2026).
        days_left = max(1, -(-int((delete_at - now).total_seconds()) // 86400))
        sender.send(
            email.plan_lapsed_reminder_message(
                user.email, _day(delete_at), days_left, plan_link(), shared=shared
            )
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
    *,
    shared: bool = False,
    covered: bool = False,
) -> None:
    """The reminder due now for a Founding term that is ending, once each: only the nearest
    stage, so a run that missed one (an outage) never sends two at once. `covered`: `user` is
    the partner the holder's term covers, whose own row says which stage they had."""
    assert sub.ends_at is not None
    left = sub.ends_at - now
    due = [d for d in load_plans()["founding"]["reminder_days_before"] if left <= timedelta(days=d)]
    if not due:
        return
    stage = int(min(due))
    if covered:
        sent = user.shared_reminded_days if user.ending_notice_for == sub.ends_at else None
    else:
        sent = sub.founding_reminded_days
    if sent is not None and sent <= stage:
        return
    sender.send(
        email.founding_ending_message(
            user.email,
            _day(sub.ends_at),
            plan_link(),
            tomorrow=left <= timedelta(days=1),
            shared=shared or covered,
        )
    )
    _push(db, user.id, now, body=FOUNDING_ENDS_SOON_LABEL, tag="founding-ends")
    if covered:
        user.ending_notice_for = sub.ends_at
        user.shared_reminded_days = stage
    else:
        sub.founding_reminded_days = stage
    counts["ending_soon"] += 1


def _covered_notices(
    db: DbSession,
    user: User,
    holder_id: uuid.UUID,
    now: datetime,
    before: timedelta,
    sender: email.EmailSender,
    counts: dict[str, int],
) -> None:
    """The partner a household's plan covers hears what its holder hears about that plan
    ending (invariant 54), stamped on their own row so each goes to them once."""
    holder = db.get(User, holder_id)
    if holder is None:
        return
    sub = active_subscription(db, holder.id, now=now)
    if sub is not None and sub.plan == "founding" and sub.ends_at is not None:
        _founding_reminder(db, user, sub, now, sender, counts, covered=True)
        return
    ending = _ending(db, holder, now)
    if ending is None:
        return
    end, trial = ending
    if end - now <= before and user.ending_notice_for != end:
        sender.send(
            email.plan_ending_message(user.email, _day(end), plan_link(), trial, shared=True)
        )
        if trial:
            _push(db, user.id, now, body=TRIAL_ENDS_TOMORROW_LABEL, tag="trial-ends")
        user.ending_notice_for = end
        counts["ending_soon"] += 1


def _dispute_lost(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a dispute the household's holder lost."""
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id.in_(user_ids), Subscription.dispute_lost_at == ended
            )
        )
        is not None
    )


def _founding_ended(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a Founding term's (its own, or the household's)."""
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id.in_(user_ids),
                Subscription.plan == "founding",
                Subscription.ends_at == ended,
            )
        )
        is not None
    )


def _trial_ended(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a free trial's (its own, or the household's)."""
    return (
        db.scalar(select(User.id).where(User.id.in_(user_ids), User.trial_ends_at == ended))
        is not None
    )
