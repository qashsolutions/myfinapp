"""The alert schedule the device registers (docs/spec.md "Notifications" → Delivery).

A date, a type and a dedupe key per alert, nothing else: the server attaches the fixed
generic label and sends the push on time. The device replaces its list whenever it recomputes.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.notification import AlertSchedule
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_unlocked
from app.services.alerts import MAX_SCHEDULE_ITEMS, replace_device_schedule

router = APIRouter(prefix="/api/alerts", tags=["alerts"], dependencies=[Depends(same_site_only)])

AlertType = Literal[
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "weekly_recap",
]


class ScheduleItem(BaseModel):
    due_at: datetime
    type: AlertType
    dedupe_key: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9:_.-]+$")


class ScheduleIn(BaseModel):
    items: list[ScheduleItem] = Field(max_length=MAX_SCHEDULE_ITEMS)


class ScheduleRow(BaseModel):
    due_at: datetime
    type: str
    generic_label: str
    dedupe_key: str
    status: str


class ScheduleOut(BaseModel):
    registered: int
    items: list[ScheduleRow]


def _rows(db: DbSession, caller: Caller) -> list[ScheduleRow]:
    rows = db.scalars(
        select(AlertSchedule)
        .where(AlertSchedule.user_id == caller.user.id, AlertSchedule.status != "sent")
        .order_by(AlertSchedule.due_at, AlertSchedule.dedupe_key)
    )
    return [
        ScheduleRow(
            due_at=r.due_at,
            type=r.type,
            generic_label=r.generic_label,
            dedupe_key=r.dedupe_key,
            status=r.status,
        )
        for r in rows
    ]


@router.get("/schedule")
def get_schedule(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> ScheduleOut:
    return ScheduleOut(registered=0, items=_rows(db, caller))


@router.put("/schedule")
def put_schedule(
    body: ScheduleIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> ScheduleOut:
    if body.items and any(i.due_at.tzinfo is None for i in body.items):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="naive_datetime")
    registered = replace_device_schedule(
        db,
        caller.user.id,
        [{"due_at": i.due_at, "type": i.type, "dedupe_key": i.dedupe_key} for i in body.items],
    )
    db.commit()
    return ScheduleOut(registered=registered, items=_rows(db, caller))
