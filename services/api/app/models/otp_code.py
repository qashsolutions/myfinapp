"""otp_codes: one-time sign-in codes, stored hashed, single use, with attempt counting."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class OtpCode(Base, StackdRow):
    __tablename__ = "otp_codes"

    email: Mapped[str] = mapped_column(String(254), index=True)  # normalised (lower-case)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime]
    attempts: Mapped[int] = mapped_column(default=0, server_default="0")
    consumed_at: Mapped[datetime | None]
    locked_until: Mapped[datetime | None]  # set after too many wrong tries
    ip_hash: Mapped[str | None] = mapped_column(String(64))
