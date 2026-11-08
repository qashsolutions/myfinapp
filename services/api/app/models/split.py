"""Split bills (docs/spec.md "Split bills"; chunk S.2; invariants 77–79).

A split group has one organizer on a paid plan and free guests. Everything about a bill (the
group's name, people's names, amounts, splits, payment handles) travels only as ciphertext
under a group key made on the organizer's device; the server keeps who is in which group,
invites bound to one inbox, the ids of bills it issued (the daily count), disputes, reports,
mistakes and the time someone accepted the pay warning. Never an amount or a name.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

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

BLOB_KINDS = ("ledger", "profile")
MISTAKE_KINDS = ("invite_declined", "bill_disputed")
REPORT_REASONS = ("dont_know", "not_owed", "pushy", "other")


class SplitGroup(Base, StackdRow):
    __tablename__ = "split_groups"

    # Null once the organizer's account is gone: the group is view-and-settle only until a
    # member with a plan runs it (`POST /api/splits/{id}/takeover`).
    organizer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )


class SplitMember(Base, StackdRow):
    __tablename__ = "split_members"
    __table_args__ = (
        Index(
            "uq_split_members_live",
            "group_id",
            "user_id",
            unique=True,
            postgresql_where=text("left_at IS NULL"),
        ),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    # Null once the account is purged; the row stays so its bills read "Former member".
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    joined_at: Mapped[datetime]
    left_at: Mapped[datetime | None]
    removed: Mapped[bool] = mapped_column(server_default=text("false"))


class SplitInvite(Base, StackdRow):
    __tablename__ = "split_invites"

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # The invited inbox as a keyed hash (canonical email, like trials): never the address.
    email_hash: Mapped[str] = mapped_column(String(64), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
    used_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    declined_at: Mapped[datetime | None]  # "I don't know <name>": that sender can't ask again
    cancelled_at: Mapped[datetime | None]


class SplitBill(Base, StackdRow):
    """A bill id the server issued: the ledger counts a bill only when its id is here
    (invariant 77), and the organizer's daily limit counts these rows (invariant 79)."""

    __tablename__ = "split_bills"

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Whose daily limit it used, and on which of their days.
    counted_for: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    counted_day: Mapped[date]


class SplitBlob(Base, StackdRow):
    __tablename__ = "split_blobs"
    __table_args__ = (
        UniqueConstraint("group_id", "member_id", "kind"),
        CheckConstraint("kind IN ('ledger', 'profile')", name="kind"),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    # The author's membership, kept after a purge, so a former member's bills still read.
    member_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_members.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    version: Mapped[int]


class SplitKey(Base, StackdRow):
    """Handing the group key to a member's device without the server reading it: the device
    posts a public key, any member's device that holds the group key wraps it to that public
    key. Both are opaque bytes here."""

    __tablename__ = "split_keys"
    __table_args__ = (UniqueConstraint("group_id", "member_id", "device_key_id"),)

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_members.id", ondelete="CASCADE"), index=True
    )
    device_key_id: Mapped[str] = mapped_column(String(64))
    public_key: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_key: Mapped[bytes | None] = mapped_column(LargeBinary)
    wrapped_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class SplitDispute(Base, StackdRow):
    __tablename__ = "split_disputes"
    __table_args__ = (
        Index(
            "uq_split_disputes_open",
            "bill_id",
            "user_id",
            unique=True,
            postgresql_where=text("closed_at IS NULL"),
        ),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="CASCADE"), index=True
    )
    bill_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("split_bills.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    closed_at: Mapped[datetime | None]  # fixed by the organizer, or withdrawn


class SplitReport(Base, StackdRow):
    __tablename__ = "split_reports"
    __table_args__ = (
        CheckConstraint("reason IN ('dont_know', 'not_owed', 'pushy', 'other')", name="reason"),
    )

    organizer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    reporter_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("split_groups.id", ondelete="SET NULL")
    )
    reason: Mapped[str] = mapped_column(String(16))


class SplitMistake(Base, StackdRow):
    __tablename__ = "split_mistakes"
    __table_args__ = (CheckConstraint("kind IN ('invite_declined', 'bill_disputed')", name="kind"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))


class SplitPayConsent(Base, StackdRow):
    """The pay warning was accepted: its version and when. Never who was paid or how much."""

    __tablename__ = "split_pay_consents"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[str] = mapped_column(String(16))
