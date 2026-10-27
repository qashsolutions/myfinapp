"""webauthn_challenges: pending registration or assertion challenges (short-lived).

`signin` (migration 0017): a passkey sign-in started before anyone is known, so it has no user
or session yet; the browser's signed response carries the challenge back and names the passkey,
which names the account."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, LargeBinary, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

KINDS = ("register", "assert", "signin")


class WebauthnChallenge(Base, StackdRow):
    __tablename__ = "webauthn_challenges"
    __table_args__ = (CheckConstraint("kind IN ('register', 'assert', 'signin')", name="kind"),)

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )  # None for a passkey sign-in until it succeeds
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)  # the device that asked
    kind: Mapped[str] = mapped_column(String(16))
    challenge: Mapped[bytes] = mapped_column(LargeBinary)
    expires_at: Mapped[datetime]
    consumed_at: Mapped[datetime | None]
