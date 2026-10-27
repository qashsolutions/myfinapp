"""plan_events: what happened to a person's plan, for the Plan history list (owner decision,
October 18, 2026).

One row per thing that actually happened, written where it happens: a trial started, a
subscription bought (the Stripe webhook, once), a switch (with what was charged, or credited
as a negative amount), a cancellation (with the date the plan runs to), a cancellation undone,
a plan ended. Plan, period, an amount and dates only; no card data. Deleted with the account.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

KINDS = ("trial_started", "subscribed", "switched", "cancelled", "resumed", "ended")


class PlanEvent(Base, StackdRow):
    __tablename__ = "plan_events"
    __table_args__ = (
        CheckConstraint(f"kind IN ({', '.join(repr(k) for k in KINDS)})", name="kind"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    plan: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str | None] = mapped_column(String(8))
    # Charged (positive) or credited (negative), in cents; null when not known.
    amount_cents: Mapped[int | None]
    until: Mapped[datetime | None]  # a cancelled plan runs to this
    at: Mapped[datetime]
