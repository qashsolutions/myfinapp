"""Short-lived records go once they can no longer be used; live ones stay."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.db import get_session_factory
from app.jobs.expired_purge import purge
from app.models.otp_code import OtpCode
from app.models.rate_limit import RateLimitBucket


def test_expired_codes_and_old_counters_are_deleted(migrated) -> None:
    now = datetime.now(UTC)
    email = f"purge-{uuid.uuid4().hex[:8]}@example.com"
    with get_session_factory()() as db:
        old = OtpCode(email=email, code_hash="x" * 64, expires_at=now - timedelta(days=2))
        fresh = OtpCode(email=email, code_hash="y" * 64, expires_at=now + timedelta(minutes=5))
        locked = OtpCode(
            email=email,
            code_hash="z" * 64,
            expires_at=now - timedelta(days=2),
            locked_until=now + timedelta(minutes=10),
        )
        db.add_all([old, fresh, locked])
        db.add(
            RateLimitBucket(
                scope="otp_send", key=f"k-{email}", window_start=now - timedelta(days=3), hits=1
            )
        )
        db.commit()
    with get_session_factory()() as db:
        counts = purge(db, now=now)
    assert counts["otp_codes"] >= 1 and counts["rate_limit_windows"] >= 1
    with get_session_factory()() as db:
        left = db.scalar(select(func.count()).select_from(OtpCode).where(OtpCode.email == email))
    assert left == 2  # the fresh code and the one under an active lockout stay
