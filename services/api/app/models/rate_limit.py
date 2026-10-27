"""rate_limit_buckets: fixed-window counters shared by every API instance."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RateLimitBucket(Base):
    __tablename__ = "rate_limit_buckets"

    scope: Mapped[str] = mapped_column(String(40), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)  # pseudonym, never a raw IP
    window_start: Mapped[datetime] = mapped_column(primary_key=True)
    hits: Mapped[int]
