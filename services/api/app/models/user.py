"""users: the account row. Preferences only; never money data."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, String, false
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

# Six looks on the web, three in the native apps (owner decision, October 12, 2026).
LOOKS = ("modern", "minimal", "retro", "pastel", "anime", "illustrative")
MODES = ("light", "dark", "system")
RECEIPT_RETENTIONS = ("90d", "1y", "forever")
# Auto-lock after this many idle minutes, the user's choice (owner decision, October 12, 2026).
LOCK_MIN_MINUTES = 5
LOCK_MAX_MINUTES = 60


def _one_of(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class User(Base, StackdRow):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(_one_of("look", LOOKS), name="look"),
        CheckConstraint(_one_of("mode", MODES), name="mode"),
        CheckConstraint(_one_of("receipt_retention", RECEIPT_RETENTIONS), name="receipt_retention"),
        CheckConstraint(
            f"lock_after_minutes BETWEEN {LOCK_MIN_MINUTES} AND {LOCK_MAX_MINUTES}",
            name="lock_after_minutes",
        ),
        CheckConstraint(
            "trial_plan IS NULL OR trial_plan IN ('private', 'connected')", name="trial_plan"
        ),
        CheckConstraint(
            "tester_plan IS NULL OR tester_plan IN ('free', 'private', 'connected', 'founding')",
            name="tester_plan",
        ),
    )

    # Stored lower-cased; sign-in (chunk 1.2) normalises before lookup.
    email: Mapped[str] = mapped_column(String(254), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(80))
    # Chosen in the native apps. The PWA reads it, renders Modern, and never writes it.
    look: Mapped[str] = mapped_column(String(16), default="modern", server_default="modern")
    mode: Mapped[str] = mapped_column(String(16), default="system", server_default="system")
    simple_layout: Mapped[bool] = mapped_column(default=False, server_default=false())
    receipt_retention: Mapped[str] = mapped_column(String(16), default="90d", server_default="90d")
    lock_after_minutes: Mapped[int] = mapped_column(default=5, server_default="5")
    deleted_at: Mapped[datetime | None]
    # Trials (owner decision, October 14, 2026; migration 0019): which trial this account picked
    # and when it ends; the end date each "ending soon" / "ended" email was sent for.
    trial_plan: Mapped[str | None] = mapped_column(String(16))
    trial_ends_at: Mapped[datetime | None]
    ending_notice_for: Mapped[datetime | None]
    lapsed_notice_for: Mapped[datetime | None]
    # The day the last friendly reminder went out in the 7 days after a plan ended (October 20,
    # 2026: one a day; migration 0027).
    lapsed_reminded_on: Mapped[date | None]
    # A household of two is one plan (owner decision, October 29, 2026; migration 0039): when
    # its shared plan stopped covering this person (they left, or its holder left or closed),
    # which starts their 7 days; and the last Founding reminder stage (30, 7, 1) sent to them
    # for the holder's term, keyed by `ending_notice_for` = that term's end.
    household_cover_ended_at: Mapped[datetime | None]
    shared_reminded_days: Mapped[int | None]
    # The household split while a payment for its plan was disputed (migration 0040): the
    # subscription whose dispute this person stays paused for, until it closes.
    household_paused_by: Mapped[uuid.UUID | None]
    # Tester tools (owner decision, October 18, 2026; migration 0022): the plan an admin chose to
    # test with, free of charge. Ignored unless the account's email is in STACKD_ADMIN_EMAILS.
    tester_plan: Mapped[str | None] = mapped_column(String(16))
