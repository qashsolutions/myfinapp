"""webauthn_credentials: the user's passkeys (public keys only; nothing here can sign)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, LargeBinary, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class WebauthnCredential(Base, StackdRow):
    __tablename__ = "webauthn_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    credential_id: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    public_key: Mapped[bytes] = mapped_column(LargeBinary)  # COSE-encoded
    sign_count: Mapped[int] = mapped_column(default=0, server_default="0")
    transports: Mapped[str | None] = mapped_column(String(120))  # comma-separated hints
    device_label: Mapped[str] = mapped_column(String(80))  # "iPhone passkey"
    last_used_at: Mapped[datetime | None]
