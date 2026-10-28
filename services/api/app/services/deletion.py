"""Account deletion (docs/spec.md "Delete account").

Soft delete happens at once: every session is revoked, passkeys and pending codes are removed,
the display name is cleared and the email is replaced by a tombstone so the address can sign
up again. Group memberships stay so the group shows "Former member", and a group the user
owned passes to its longest-standing other member (owner sign-off, October 27, 2026) so it survives the purge. The
hard purge, after the grace period, deletes the user row and everything that cascades from
it; `stackd-api purge-deleted` runs it (a scheduled job in production). The device wipes its
own copy. A live Stripe subscription is ended at once, with no further charge, and the unused
part of what was paid is refunded to the card (owner decision, October 17, 2026).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session as DbSession

from app.models.billing import PurchaseConsent, Subscription
from app.models.group import Group
from app.models.group_member import GroupMember
from app.models.linking import BankConnection
from app.models.otp_code import OtpCode
from app.models.session import Session
from app.models.user import User
from app.models.webauthn_credential import WebauthnCredential
from app.security import audit
from app.security.audit import AuditAction
from app.services import backup_store

log = logging.getLogger("stackd.deletion")


def _lock_person(db: DbSession, user_id: uuid.UUID) -> None:
    """Every deletion path takes the person's row before their plans, the order every Stripe
    webhook uses (stripe_billing._lock_person): ending a plan at Stripe sends a webhook straight
    back, and it waits for the deletion instead of deadlocking with it (found by the payments
    e2e, October 24, 2026; the purge joined October 25, 2026). FOR UPDATE: the row may go."""
    db.execute(select(User.id).where(User.id == user_id).with_for_update())


def tombstone_email(user_id: uuid.UUID) -> str:
    return f"deleted+{user_id}@deleted.invalid"


def _live_stripe(db: DbSession, user_id: uuid.UUID, now: datetime) -> list[Subscription]:
    rows = db.scalars(
        select(Subscription).where(
            Subscription.user_id == user_id,
            Subscription.source == "stripe",
            Subscription.external_id.is_not(None),
        )
    ).all()
    return [
        r
        for r in rows
        if r.status in ("active", "past_due")
        or (r.status == "canceled" and r.ends_at is not None and r.ends_at > now)
    ]


def _disputed(rows) -> set[str]:
    """Customers with a disputed payment (October 24, 2026): their bank has already returned
    the money (and keeps it if the dispute is lost), so deleting the account refunds nothing
    more, credit included, rather than paying twice."""
    return {r.customer_id for r in rows if r.disputed_at is not None and r.customer_id}


def cancel_billing(
    db: DbSession,
    user_id: uuid.UUID,
    *,
    now: datetime | None = None,
    as_of: datetime | None = None,
) -> bool:
    """End every live Stripe plan at once, so a deleted account is never charged again
    (October 16, 2026), and refund what was paid for and not used (October 17, 2026): the
    current month is kept and the months after it are refunded at the price paid, with any
    credit left from downgrades, and the same for the years of a Founding payment, each refund
    less Stripe's card fee (plans.yaml `refunds`), which Stripe keeps on a refund. A plan
    behind on payment ends with no refund, and so does one with a disputed payment. The amount
    is worked out once and kept on the row (`refund_due_cents`) until paid, so the purge's
    retry never pays twice. Returns False when Stripe could not be reached for one; the purge
    then waits and tries again. App Store and Play plans are managed and refunded in the
    stores.

    `as_of`: when the account was deleted, for a retry after Stripe was unreachable then
    (October 25, 2026). The refund is worked out as of that day, and any charge Stripe made
    after it (a renewal it couldn't be stopped from taking) is refunded in full."""
    from app.services import stripe_billing  # noqa: PLC0415 - keeps deletion light to import

    now = now or datetime.now(UTC)
    late = as_of is not None and as_of < now - timedelta(minutes=1)
    ended = True
    for sub in _live_stripe(db, user_id, now):
        assert sub.external_id is not None
        try:
            if sub.refund_due_cents is None:
                sub.refund_due_cents = stripe_billing.deletion_refund(sub, now, as_of=as_of)[0]
                db.flush()
            if sub.interval:
                stripe_billing.cancel_now(sub.external_id)  # we refund what's due ourselves
        except stripe_billing.BillingError:
            ended = False
            continue
        sub.status = "canceled"
        sub.stripe_status = "canceled"  # final: a late webhook can't reopen it (October 24, 2026)
        sub.ends_at = now
        sub.cancel_at_period_end = False
    rows = db.scalars(
        select(Subscription).where(Subscription.user_id == user_id, Subscription.source == "stripe")
    ).all()
    for sub in rows:  # Founding: one payment, refunded against it
        if sub.interval is None and sub.refund_due_cents and sub.disputed_at is not None:
            # Disputed since the amount was worked out: the bank has the money, so nothing
            # more is refunded, as for renewing plans (`_disputed`); Stripe would refuse the
            # refund on every retry and the purge would wait for ever (October 27, 2026).
            sub.refund_due_cents = 0
            continue
        if sub.interval is None and sub.refund_due_cents and sub.external_id:
            try:
                stripe_billing.refund_payment(
                    sub.external_id, sub.refund_due_cents, key=f"founding:{sub.id}"
                )
                sub.refund_due_cents = 0
            except stripe_billing.BillingError:
                ended = False
    for customer_id in sorted({r.customer_id for r in rows if r.customer_id} - _disputed(rows)):
        owed = [
            r for r in rows if r.customer_id == customer_id and r.interval and r.refund_due_cents
        ]
        if late and ended:
            # First, so the refund of unused months below goes to charges made before deletion.
            try:
                stripe_billing.refund_charges_since(
                    customer_id, as_of, key=f"after_deletion:{user_id}"
                )
            except stripe_billing.BillingError:
                ended = False
                continue
        try:
            stripe_billing.refund_credit(
                customer_id,
                key=f"closeout:{user_id}",
                extra_cents=sum(r.refund_due_cents or 0 for r in owed),
            )
        except stripe_billing.BillingError:
            ended = False
            continue
        for r in owed:
            r.refund_due_cents = 0
    db.flush()
    return ended


def refund_preview(
    db: DbSession, user_id: uuid.UUID, *, now: datetime | None = None
) -> tuple[int, int, datetime | None]:
    """What `cancel_billing` would refund if the account were deleted now, in cents, after
    Stripe's fee for how it was paid (card or bank); the amount before the fee; and the end of
    the month that is kept (None without a live plan)."""
    from app.services import stripe_billing  # noqa: PLC0415

    now = now or datetime.now(UTC)
    total, gross, kept = 0, 0, None
    customers = {
        s.customer_id
        for s in db.scalars(
            select(Subscription).where(
                Subscription.user_id == user_id, Subscription.source == "stripe"
            )
        )
        if s.customer_id
    }
    by_customer: dict[str, int] = {c: 0 for c in customers}
    for sub in _live_stripe(db, user_id, now):
        cents, until = stripe_billing.deletion_refund(sub, now)
        kept = until or kept
        if sub.interval is None:  # Founding: its own refund, its own fee
            method = (
                stripe_billing.payment_method_of_intent(sub.external_id)
                if cents and sub.external_id
                else "card"
            )
            total += cents - stripe_billing.refund_fee_cents(cents, method)
            gross += cents
        elif sub.customer_id:
            by_customer[sub.customer_id] = by_customer.get(sub.customer_id, 0) + cents
    disputed = _disputed(
        db.scalars(
            select(Subscription).where(
                Subscription.user_id == user_id, Subscription.source == "stripe"
            )
        )
    )
    for customer_id, due in sorted(by_customer.items()):
        if customer_id in disputed:
            continue  # as cancel_billing: nothing comes back while a payment is disputed
        owed = due + stripe_billing.customer_credit(customer_id)
        method = stripe_billing.payment_method_of_customer(customer_id) if owed else "card"
        total += owed - stripe_billing.refund_fee_cents(owed, method)
        gross += owed
    return total, gross, kept


def soft_delete(
    db: DbSession, user: User, *, now: datetime | None = None, plan_ended: bool = False
) -> None:
    """`plan_ended`: closed because a plan ran out (not asked for), so devices keep their copy
    until the person decides (owner, October 20, 2026); every other deletion erases them."""
    now = now or datetime.now(UTC)
    _lock_person(db, user.id)
    if not cancel_billing(db, user.id, now=now):
        # Stripe couldn't be reached: `settle_billing` (hourly) tries again, as of this moment,
        # so the person is never charged on for the 30 days until the purge.
        from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

        report("deletion_billing_pending", "soft_delete", None)
    for row in db.scalars(
        select(Session).where(Session.user_id == user.id, Session.revoked_at.is_(None))
    ):
        row.revoked_at = now
        row.ended_reason = "plan_ended" if plan_ended else "account_deleted"
    db.execute(delete(WebauthnCredential).where(WebauthnCredential.user_id == user.id))
    db.execute(delete(OtpCode).where(OtpCode.email == user.email))
    for group in db.scalars(select(Group).where(Group.owner_id == user.id)):
        successor = db.scalar(
            select(GroupMember.user_id)
            .where(
                GroupMember.group_id == group.id,
                GroupMember.user_id != user.id,
                GroupMember.left_at.is_(None),
            )
            .order_by(GroupMember.joined_at, GroupMember.id)
            .limit(1)
        )
        if successor is not None:
            group.owner_id = successor
    # The encrypted backup goes now (docs/spec.md "Delete account"); the device wipes its own copy.
    backup_store.delete_all(db, user.id)
    from app.routers.household import leave_households  # noqa: PLC0415 - avoids a router import cycle

    leave_households(db, user.id, now=now)
    from app.routers.linking import revoke_all  # noqa: PLC0415 - same cycle as above

    revoke_all(db, user.id)
    _keep_payer(db, user)
    user.deleted_at = now
    user.display_name = None
    user.email = tombstone_email(user.id)
    db.flush()


def _keep_payer(db: DbSession, user: User) -> None:
    """Before the address is tombstoned, put the inbox and the Stripe customer on the person's
    purchase records (kept 7 years for payment disputes, as the privacy policy says), so a
    dispute lost or a fraud warning after the deletion or the purge still blocks the inbox
    (October 27, 2026). Records made since then already carry the inbox."""
    from app.services.stripe_billing import purchase_block_key  # noqa: PLC0415 - light imports

    db.execute(
        update(PurchaseConsent)
        .where(PurchaseConsent.user_id == user.id, PurchaseConsent.inbox_key.is_(None))
        .values(inbox_key=purchase_block_key(user.email))
    )
    customer = db.scalar(
        select(Subscription.customer_id)
        .where(
            Subscription.user_id == user.id,
            Subscription.source == "stripe",
            Subscription.customer_id.is_not(None),
        )
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    if customer:
        db.execute(
            update(PurchaseConsent)
            .where(
                PurchaseConsent.user_id == user.id,
                PurchaseConsent.stripe_customer_id.is_(None),
            )
            .values(stripe_customer_id=customer)
        )


def settle_billing(db: DbSession, *, now: datetime | None = None) -> int:
    """Deleted accounts whose plan Stripe still holds (it was unreachable at the deletion): end
    it and refund as of the deletion (October 25, 2026). Hourly in `jobs-loop`, so nobody is
    charged on for the 30 days until the purge; each account in its own savepoint, the person
    locked first. Returns how many were settled."""
    now = now or datetime.now(UTC)
    pending = db.scalars(
        select(User)
        .join(Subscription, Subscription.user_id == User.id)
        .where(
            User.deleted_at.is_not(None),
            Subscription.source == "stripe",
            or_(
                Subscription.stripe_status.is_distinct_from("canceled"),
                Subscription.refund_due_cents > 0,
            ),
        )
        .distinct()
    ).all()
    settled = 0
    for user in pending:
        try:
            with db.begin_nested():
                _lock_person(db, user.id)
                if cancel_billing(db, user.id, now=now, as_of=user.deleted_at):
                    settled += 1
                else:
                    from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

                    report("deletion_billing_pending", "settle_billing", None)
        except DBAPIError as exc:
            from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

            report("deletion_billing_pending", "settle_billing", exc)
    db.flush()
    return settled


def purge_due(db: DbSession, *, grace_days: int, now: datetime | None = None) -> int:
    """Hard-delete accounts whose grace period is over. Returns how many went."""
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=grace_days)
    users = db.scalars(
        select(User).where(User.deleted_at.is_not(None), User.deleted_at <= cutoff)
    ).all()
    purged = 0
    for user in users:
        # One account at a time in its own savepoint: anything that fails for one (a lock wait
        # that times out, a database error) leaves it for the next run, never the whole batch.
        try:
            with db.begin_nested():
                purged += _purge_one(db, user, now)
        except DBAPIError as exc:
            log.warning("purge skipped one account; it is retried on the next run")
            from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

            report("purge_skipped", "purge_due", exc)
    db.flush()
    return purged


def _purge_one(db: DbSession, user: User, now: datetime) -> int:
    _lock_person(db, user.id)
    # Never drop a live token with the account (chunk 3.4): revoke what is left, and if the
    # provider still refuses, keep the account until `stackd-api revoke-links` succeeds.
    from app.routers.linking import revoke_all  # noqa: PLC0415 - avoids a router import cycle

    revoke_all(db, user.id)
    if db.scalar(select(BankConnection.id).where(BankConnection.user_id == user.id)):
        return 0
    # Never drop an account Stripe may still charge: retry, and wait if it still fails.
    if not cancel_billing(db, user.id, now=now, as_of=user.deleted_at):
        return 0
    user_id = user.id
    db.delete(user)
    # The record outlives the account (audit_log has no foreign key): which account was
    # erased and when, written by the job, so no person and no IP.
    audit.record(
        db, actor_id=None, action=AuditAction.DELETE_COMPLETED, target=f"user:{user_id}", at=now
    )
    db.flush()
    return 1
