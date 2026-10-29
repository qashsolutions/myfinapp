"""group_members: who is in a group, and the one number the server knows about them.

progress_bps is percent of the member's own target in basis points (10000 = 100%); the target
itself never leaves the device. reached_at is the first time the member hit 100% (the rank
tie-break). A row with left_at set is a former member; a deleted user's row stays so the group
can show "Former member". removed_at is set too when the owner removed them (invariant 45,
October 29, 2026): a removed member can't come back with any code, while one who left may.

helped is the member's own "What helped" answer: up to 5 ids (3 until October 29, 2026) from the
one fixed list (stackd_rules/config/helped.yaml), comma separated, never free text. Other members
only ever see totals across the group, and only once at least min_answers members other than the
viewer answered (invariant 29). Leaving or being removed clears it.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

# Lower-case ids, one to five, comma separated (the list itself is checked by the router).
HELPED_CHECK = "helped IS NULL OR helped ~ '^[a-z_]{2,32}(,[a-z_]{2,32}){0,4}$'"


class GroupMember(Base, StackdRow):
    __tablename__ = "group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id"),
        CheckConstraint("progress_bps >= 0", name="progress_bps"),
        CheckConstraint(HELPED_CHECK, name="helped"),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("groups.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    joined_at: Mapped[datetime]
    left_at: Mapped[datetime | None]
    removed_at: Mapped[datetime | None]  # the owner removed them; never cleared (migration 0038)
    progress_bps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    progress_updated_at: Mapped[datetime | None]
    reached_at: Mapped[datetime | None]
    helped: Mapped[str | None] = mapped_column(String(200))
