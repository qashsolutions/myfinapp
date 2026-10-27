"""device_links: "Link with your phone" (owner decisions, October 19, 2026; docs/spec.md
"Signing in on another device").

A computer asks to be signed in and shows a short code (and a QR code of it); a phone that is
signed in, unlocked and has just passed a passkey check approves it; the computer then picks up
a session for the approving account, once. Only keyed hashes of the code and of the computer's
secret are stored, with a pseudonym of the computer's network for the "different network"
warning. Rows live minutes; `purge-expired` removes them after a day.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

STATUSES = ("pending", "approved", "consumed", "denied")


class DeviceLink(Base, StackdRow):
    __tablename__ = "device_links"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'approved', 'consumed', 'denied')", name="status"),
    )

    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64), unique=True)  # the computer's cookie
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    device_label: Mapped[str] = mapped_column(String(80))  # "Chrome · Mac"
    network_hash: Mapped[str | None] = mapped_column(String(32))  # pseudonym of the /24 or /64
    ip_hash: Mapped[str | None] = mapped_column(String(32))
    expires_at: Mapped[datetime]
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    approved_at: Mapped[datetime | None]
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sessions.id", ondelete="SET NULL")
    )  # the computer's session, once picked up
