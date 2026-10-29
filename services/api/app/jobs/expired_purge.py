"""Short-lived records are deleted once they can no longer be used (docs/security/
data-retention-policy.md). A daily scheduled job; each table keeps a margin past its own expiry
so nothing in use is ever removed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_
from sqlalchemy.orm import Session as DbSession

from app.models.billing import BillingEvent, CheckoutPage, PurchaseConsent
from app.models.device_link import DeviceLink
from app.models.household import HouseholdInvite
from app.models.linking import LinkSession
from app.models.otp_code import OtpCode
from app.models.rate_limit import RateLimitBucket
from app.models.webauthn_challenge import WebauthnChallenge


def purge(db: DbSession, *, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    day = now - timedelta(days=1)
    counts = {
        # Sign-in codes: 10-minute life; kept a day, and never while a lockout is running.
        "otp_codes": db.execute(
            delete(OtpCode).where(
                OtpCode.expires_at < day,
                or_(OtpCode.locked_until.is_(None), OtpCode.locked_until < now),
            )
        ).rowcount,
        # Passkey challenges: minutes long.
        "passkey_challenges": db.execute(
            delete(WebauthnChallenge).where(WebauthnChallenge.expires_at < day)
        ).rowcount,
        # Rate-limit counters: the longest window is 24 hours.
        "rate_limit_windows": db.execute(
            delete(RateLimitBucket).where(RateLimitBucket.window_start < now - timedelta(days=2))
        ).rowcount,
        # Bank-link sessions: finished or abandoned trips to Plaid's page.
        "link_sessions": db.execute(
            delete(LinkSession).where(LinkSession.expires_at < day)
        ).rowcount,
        # Stripe payment pages: 31 minutes at most (24 hours for pages opened before October
        # 29, 2026); kept a day past closing.
        "checkout_pages": db.execute(
            delete(CheckoutPage).where(CheckoutPage.expires_at < day)
        ).rowcount,
        # "Link with your phone" requests: 2-minute codes, kept a day.
        "device_links": db.execute(delete(DeviceLink).where(DeviceLink.expires_at < day)).rowcount,
        # Household invites: 7-day codes, kept a week past expiry.
        "household_invites": db.execute(
            delete(HouseholdInvite).where(HouseholdInvite.expires_at < now - timedelta(days=7))
        ).rowcount,
        # Payment-webhook receipts (only event ids, to ignore redeliveries): 13 months.
        "billing_event_ids": db.execute(
            delete(BillingEvent).where(BillingEvent.created_at < now - timedelta(days=396))
        ).rowcount,
        # "Before you subscribe" agreements: 7 years (payment disputes and tax records).
        "purchase_consents": db.execute(
            delete(PurchaseConsent).where(
                PurchaseConsent.agreed_at < now - timedelta(days=7 * 365 + 2)
            )
        ).rowcount,
    }
    db.commit()
    return {k: int(v or 0) for k, v in counts.items()}
