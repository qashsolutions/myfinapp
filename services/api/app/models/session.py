"""sessions: one row per signed-in device.

docs/spec.md "Authentication": refresh tokens per device, listed under Active devices, revocable.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class Session(Base, StackdRow):
    __tablename__ = "sessions"
    # Why a session ended, so Sign-in & security can say so (October 13, 2026); this check is
    # the one list of reasons ('plan_ended' since migration 0027).
    __table_args__ = (
        CheckConstraint(
            "ended_reason IS NULL OR ended_reason IN "
            "('signed_out', 'signed_out_remote', 'account_deleted', 'plan_ended')",
            name="ended_reason",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # HMAC of the cookie value. The cookie is the per-device refresh token; it never touches
    # the database in clear.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    device_label: Mapped[str] = mapped_column(String(80))  # "Safari on iPhone · Home Screen app"
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    last_seen_at: Mapped[datetime]
    expires_at: Mapped[datetime]
    passkey_verified_at: Mapped[datetime | None]  # last passkey check on this device
    # Set when the app's screen locked (POST /api/auth/lock, October 28, 2026): locked here
    # too until the next passkey check, whatever the idle clock says (migration 0032).
    locked_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]
    ended_reason: Mapped[str | None] = mapped_column(String(24))
