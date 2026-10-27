"""groups: a monthly savings challenge shared by several people (docs/spec.md "Groups").

The server keeps the name, the month, the invite code and who is in it. Each member's target
and deposits stay on their device; only a percentage ever arrives (group_members.progress_bps).
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

# Fast-follow 4 (docs/spec.md "Goals & challenges"): the monthly savings challenge plus
# No-Eat-Out Week, Dining diet, No-spend weekend and 52-week saving.
TEMPLATE_KEYS = (
    "monthly_savings",
    "no_eat_out_week",
    "dining_diet",
    "no_spend_weekend",
    "fifty_two_week",
)
TEMPLATE_SQL = ", ".join(repr(k) for k in TEMPLATE_KEYS)


class Group(Base, StackdRow):
    __tablename__ = "groups"
    __table_args__ = (CheckConstraint(f"template_key IN ({TEMPLATE_SQL})", name="template_key"),)

    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(60))
    template_key: Mapped[str] = mapped_column(
        String(32), default="monthly_savings", server_default="monthly_savings"
    )
    invite_code: Mapped[str] = mapped_column(String(8), unique=True)  # STK-XXXX
    start_date: Mapped[date]
    end_date: Mapped[date]
