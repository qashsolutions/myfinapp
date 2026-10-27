"""The Plan history list (owner decision, October 18, 2026): one row per plan event."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DbSession

from app.models.plan_event import PlanEvent


def add(
    db: DbSession,
    user_id: uuid.UUID,
    kind: str,
    plan: str,
    interval: str | None = None,
    *,
    amount_cents: int | None = None,
    until: datetime | None = None,
    at: datetime | None = None,
) -> None:
    db.add(
        PlanEvent(
            user_id=user_id,
            kind=kind,
            plan=plan,
            interval=interval,
            amount_cents=amount_cents,
            until=until,
            at=at or datetime.now(UTC),
        )
    )
