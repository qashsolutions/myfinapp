"""account_recoveries: getting back in without a passkey (owner decision, October 30, 2026;
docs/spec.md "Getting back in"; invariant 74).

Someone who lost every passkey signs in with an email code, which leaves the session locked,
and asks to get back in. The request is ready when its 24 hours are up (`ready_at`), or at
once when their household partner, on the same household plan, types the code the person
reads to them. While it waits, any passkey check on the account (the owner on a device they
still have) cancels it, and so does Cancel on a signed-in device. Once ready, the account may
add a new passkey; the first one added removes every old passkey and ends every other session.
Only keyed hashes of the partner code are stored; rows are purged a while after they close.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class AccountRecovery(Base, StackdRow):
    __tablename__ = "account_recoveries"
    __table_args__ = (
        CheckConstraint("status IN ('waiting', 'done', 'cancelled')", name="status"),
        # One waiting request per account, whatever arrives at once (invariant 74).
        Index(
            "uq_account_recoveries_waiting",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'waiting'"),
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="waiting", server_default="waiting")
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sessions.id", ondelete="SET NULL")
    )  # the email-code session asking now (moves to whoever asks the partner)
    started_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sessions.id", ondelete="SET NULL")
    )  # the session that started it: the only locked one that may cancel
    device_label: Mapped[str] = mapped_column(String(80))
    ready_at: Mapped[datetime]  # asked + 24 hours
    expires_at: Mapped[datetime]  # ready + 7 days to add the new passkey
    # The partner who may approve, the code they type (hashed), and when they did.
    partner_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL")
    )
    partner_code_hash: Mapped[str | None] = mapped_column(String(64))
    partner_approved_at: Mapped[datetime | None]
    # Wrong codes the partner typed for the current code; at 5 the code stops working.
    partner_attempts: Mapped[int] = mapped_column(default=0, server_default="0")
    # The session the partner approved (the one that read out the code): only it may finish
    # early, and asking again clears the approval.
    approved_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sessions.id", ondelete="SET NULL")
    )
    closed_at: Mapped[datetime | None]
    # cancelled: "passkey" (a passkey check), "owner" (Cancel on a device), "expired"
    closed_reason: Mapped[str | None] = mapped_column(String(16))
