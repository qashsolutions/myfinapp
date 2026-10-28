"""households, household_members, household_invites, household_blobs (docs/spec.md "Couples &
household"). A household is two people. Shared data travels as ciphertext under a key made
on the inviter's device and passed in the invite link; the server stores what it cannot read.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

BLOB_KINDS = ("jars", "summary")
MAX_MEMBERS = 2


class Household(Base, StackdRow):
    __tablename__ = "households"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )


class HouseholdMember(Base, StackdRow):
    __tablename__ = "household_members"
    # One household at a time per person, whatever a route does (October 28, 2026).
    __table_args__ = (
        Index(
            "uq_household_members_live_user",
            "user_id",
            unique=True,
            postgresql_where=text("left_at IS NULL"),
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("households.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    joined_at: Mapped[datetime]
    left_at: Mapped[datetime | None]


class HouseholdInvite(Base, StackdRow):
    __tablename__ = "household_invites"

    household_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("households.id", ondelete="CASCADE"), index=True
    )
    code: Mapped[str] = mapped_column(String(12), unique=True)  # HH-XXXXXX
    expires_at: Mapped[datetime]
    used_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    used_at: Mapped[datetime | None]


class HouseholdBlob(Base, StackdRow):
    __tablename__ = "household_blobs"
    __table_args__ = (
        UniqueConstraint("household_id", "author_id", "kind"),
        CheckConstraint("kind IN ('jars', 'summary')", name="kind"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("households.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    version: Mapped[int]
