"""trial_claims: one trial per email (owner decision, October 14, 2026).

Only a keyed pseudonym of the address is kept, and it outlives the account on purpose: a
deleted account's address can sign up afresh but cannot start a second free trial.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow
from app.security.hashing import pseudonym
from app.services.otp import canonical_email, normalize_email


class TrialClaim(Base, StackdRow):
    __tablename__ = "trial_claims"

    email_hash: Mapped[str] = mapped_column(String(64), unique=True)
    plan: Mapped[str] = mapped_column(String(16))
    claimed_at: Mapped[datetime]


def trial_hashes(email: str) -> list[str]:
    """Keys a claim may be stored under: the inbox (since October 24, 2026), then the exact
    address, which claims made before that date used."""
    keys = [pseudonym(canonical_email(email)), pseudonym(normalize_email(email))]
    return list(dict.fromkeys(keys))
