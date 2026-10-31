"""subscriptions, entitlements and the webhook events already applied (docs/spec.md data
model). A plan row per purchase; the limits derived from it live in `entitlements`."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

PLANS = ("free", "private", "connected", "founding")
SOURCES = ("stripe", "apple", "google")
STATUSES = ("active", "past_due", "canceled", "expired", "incomplete")
CONSENT_KINDS = ("purchase", "change", "cancel")


def _one_of(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Subscription(Base, StackdRow):
    __tablename__ = "subscriptions"
    __table_args__ = (
        CheckConstraint(_one_of("plan", PLANS), name="plan"),
        CheckConstraint(_one_of("source", SOURCES), name="source"),
        CheckConstraint(_one_of("status", STATUSES), name="status"),
        # The Founding count (entitlements.founding_taken) reads only Founding rows, so the Plan
        # screen's "places left" never scans every subscription (load test, October 31, 2026).
        Index("ix_subscriptions_founding", "status", postgresql_where=text("plan = 'founding'")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    plan: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(16))
    external_id: Mapped[str | None] = mapped_column(
        String(120), unique=True
    )  # Stripe sub / payment
    customer_id: Mapped[str | None] = mapped_column(String(120))  # Stripe customer
    status: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str | None] = mapped_column(String(8))  # monthly | yearly | null (founding)
    renews_at: Mapped[datetime | None]
    ends_at: Mapped[datetime | None]  # founding term end, or when a cancelled plan stops
    # The last Founding reminder sent for this term: 30, 7 or 1 (days before `ends_at`), so
    # each goes once (October 28, 2026, migration 0033).
    founding_reminded_days: Mapped[int | None]
    cancel_at_period_end: Mapped[bool] = mapped_column(default=False, server_default=false())
    # The last switch between plans (migration 0021): a downgrade opens `downgrade_after_days`
    # (plans.yaml `changes`) after this or after the subscription started, whichever is later.
    plan_changed_at: Mapped[datetime | None]
    # Account deletion (October 17, 2026): the refund owed for the months after the current one,
    # worked out once and kept until paid (0 once refunded), so a retry never pays twice.
    refund_due_cents: Mapped[int | None]
    # Webhook ordering (migration 0028, October 24, 2026): Stripe may deliver events late or out
    # of order, so the newest event applied is kept and older ones are skipped; Stripe's own
    # status is kept too, since a subscription Stripe has canceled never comes back.
    last_event_at: Mapped[datetime | None]
    stripe_status: Mapped[str | None] = mapped_column(String(32))
    # A payment on this plan is disputed with the bank (owner decision, October 24, 2026): the
    # plan pauses until the dispute is won or withdrawn. Nothing is deleted for it.
    disputed_at: Mapped[datetime | None]
    # The dispute was lost (October 25, 2026): the plan has ended and the account lapses as usual.
    # `disputed_at` stays, so deletion still refunds nothing more.
    dispute_lost_at: Mapped[datetime | None]
    # A subscription's first payment by US bank (October 24, 2026): Stripe marks it active while
    # the debit is still clearing, so the plan waits on this: "pending" until the checkout's
    # async_payment_succeeded ("paid"), "failed" if it doesn't go through. Null for cards.
    # "refused" (October 29, 2026): a second plan paid beside a live one, ended at once and
    # refunded in full; like "failed", it never started.
    first_payment: Mapped[str | None] = mapped_column(String(16))


class Entitlement(Base, StackdRow):
    __tablename__ = "entitlements"
    __table_args__ = (UniqueConstraint("user_id", "key"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(40))
    value: Mapped[str] = mapped_column(String(40))  # "4", "true", "unlimited"
    derived_from: Mapped[uuid.UUID | None] = mapped_column(Uuid)  # subscriptions.id


class BillingEvent(Base, StackdRow):
    """Webhook events already applied, so a redelivery changes nothing."""

    __tablename__ = "billing_events"

    event_id: Mapped[str] = mapped_column(String(120), unique=True)
    # Written, not read by the app: the event's type, for investigating a payment.
    kind: Mapped[str] = mapped_column(String(64))


class PurchaseConsent(Base, StackdRow):
    """A "Before you subscribe" agreement (owner decision, October 14, 2026): what the person
    saw and ticked before the payment page, recorded before Checkout opens. Kept after account
    deletion (user_id becomes null; the email stays only as a keyed pseudonym) for payment
    disputes, and purged after 7 years. No card data, ever."""

    __tablename__ = "purchase_consents"
    __table_args__ = (CheckConstraint(_one_of("kind", CONSENT_KINDS), name="consent_kind"),)

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    email_hash: Mapped[str] = mapped_column(String(64))
    plan: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str | None] = mapped_column(String(8))
    price_cents: Mapped[int]
    terms_version: Mapped[str] = mapped_column(String(16))
    terms_text: Mapped[str] = mapped_column(Text)
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    device_label: Mapped[str | None] = mapped_column(String(80))
    agreed_at: Mapped[datetime]
    # What was agreed to: a purchase, a plan change, or a cancellation (October 18, 2026).
    kind: Mapped[str] = mapped_column(String(16), server_default="purchase")
    # A purchase block follows the person (October 27, 2026): the inbox that agreed, keyed as
    # purchase blocks are, and the Stripe customer that paid, so a lost dispute or a fraud
    # refund still blocks the inbox after the account is deleted or purged.
    inbox_key: Mapped[str | None] = mapped_column(String(64))
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), index=True)


class CheckoutPage(Base, StackdRow):
    """A Stripe payment page opened for the person (October 29, 2026): kept only while it can
    still be paid, so opening a new one first closes the others and two pages can never both
    be paid for. No amounts; deleted by `purge-expired` a day after it closes."""

    __tablename__ = "checkout_pages"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    session_id: Mapped[str] = mapped_column(String(120))
    expires_at: Mapped[datetime]


BLOCK_REASONS = ("dispute_lost", "fraud_warning")


class PurchaseBlock(Base, StackdRow):
    """An inbox that may not buy again (owner decision, October 24, 2026): its holder lost a
    payment dispute and kept the money, or the card's bank flagged a payment as not made by
    the cardholder and it was refunded. Only a keyed pseudonym of the inbox
    (`otp.canonical_email`) is kept, and it outlives the account on purpose, like a trial
    claim. Lifted by hand only."""

    __tablename__ = "purchase_blocks"
    __table_args__ = (CheckConstraint(_one_of("reason", BLOCK_REASONS), name="block_reason"),)

    email_hash: Mapped[str] = mapped_column(String(64), unique=True)
    reason: Mapped[str] = mapped_column(String(16))
