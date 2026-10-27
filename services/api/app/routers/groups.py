"""Groups: the monthly savings challenge (docs/spec.md "Groups").

Each member saves toward their own target for the calendar month and is ranked by percent of
that target. The target and every deposit stay on the member's device: the server holds the
group's name, dates and invite code, who is in it, and one percentage per member. Members see
display names and initials only, never emails or amounts. The leaderboard order itself is the
`groups.rank` rule, run on the device over what this router returns.
"""

from __future__ import annotations

import calendar
import re
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.group import Group
from app.models.group_member import GroupMember
from app.models.user import User
from app.rules_server.entitlements import check_limit, require_feature
from app.security.audit import AuditAction, record
from app.security.authz import not_found
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_unlocked
from app.security.rate_limit import rate_limited
from app.services import alerts as alerts_svc

router = APIRouter(prefix="/api/groups", tags=["groups"], dependencies=[Depends(same_site_only)])

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I to read aloud safely
CODE_RE = re.compile(r"^STK-[A-Z0-9]{4}$")
MAX_PROGRESS_BPS = 1_000_000  # 10,000% of a target: nothing real goes past this
FORMER_MEMBER = "Former member"


TemplateKey = Literal[
    "monthly_savings", "no_eat_out_week", "dining_diet", "no_spend_weekend", "fifty_two_week"
]
DEFAULT_NAMES = {
    "monthly_savings": "Savings challenge",
    "no_eat_out_week": "No-Eat-Out Week",
    "dining_diet": "Dining diet",
    "no_spend_weekend": "No-spend weekend",
    "fifty_two_week": "52-week saving",
}
MAX_START_AHEAD_DAYS = 31  # a challenge starts today or within a month (proposed)


class CreateGroupRequest(BaseModel):
    name: str = Field(default="", max_length=60)  # empty: the template's own name
    template_key: TemplateKey = "monthly_savings"
    month: str | None = Field(default=None, pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")  # monthly kinds
    start_date: date | None = None  # week, weekend and 52-week kinds: the member's local date


class CodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=12)


class ProgressRequest(BaseModel):
    progress_bps: int = Field(ge=0, le=MAX_PROGRESS_BPS)


class MemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initial: str
    progress_bps: int
    reached_at: str | None  # ISO UTC to the second, or null
    has_events: bool
    is_me: bool
    is_owner: bool
    former: bool


class GroupSummary(BaseModel):
    id: uuid.UUID
    name: str
    template_key: str
    start_date: date
    end_date: date
    invite_code: str
    is_owner: bool
    member_count: int
    my_progress_bps: int


class GroupDetail(GroupSummary):
    members: list[MemberOut]


class GroupPreview(BaseModel):
    id: uuid.UUID
    name: str
    template_key: str
    started_by: str
    start_date: date
    end_date: date
    member_count: int
    already_member: bool


def _now() -> datetime:
    return datetime.now(UTC)


def _utc(value: datetime | None) -> str | None:
    """ISO UTC to the second ("2026-10-12T09:00:00Z"): the exact form the groups.rank rule
    accepts, whatever zone the database connection reports."""
    if value is None:
        return None
    return value.astimezone(UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalise_code(code: str) -> str:
    code = code.strip().upper().replace(" ", "")
    if not CODE_RE.fullmatch(code):
        raise not_found()
    return code


def _new_code(db: DbSession) -> str:
    while True:
        code = "STK-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        if db.scalar(select(Group.id).where(Group.invite_code == code)) is None:
            return code


def _month_bounds(month: str) -> tuple[date, date]:
    year, mon = int(month[:4]), int(month[5:7])
    return date(year, mon, 1), date(year, mon, calendar.monthrange(year, mon)[1])


def _dates_for(body: CreateGroupRequest) -> tuple[date, date]:
    """Each template's span: the calendar month, a week, a weekend (two days), or 52 weeks."""
    if body.template_key in ("monthly_savings", "dining_diet"):
        if body.month is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="month_required")
        return _month_bounds(body.month)
    if body.start_date is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="start_date_required")
    today = _now().date()
    if (
        not today - timedelta(days=1)
        <= body.start_date
        <= today + timedelta(days=MAX_START_AHEAD_DAYS)
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="start_date_out_of_range")
    days = {"no_eat_out_week": 6, "no_spend_weekend": 1, "fifty_two_week": 52 * 7 - 1}[
        body.template_key
    ]
    return body.start_date, body.start_date + timedelta(days=days)


def _shown_name(user: User) -> tuple[str, str]:
    if user.deleted_at is not None:
        return FORMER_MEMBER, "-"
    name = (user.display_name or "").strip() or "Member"
    return name, name[0].upper()


def _group_or_404(db: DbSession, group_id: uuid.UUID) -> Group:
    group = db.get(Group, group_id)
    if group is None:
        raise not_found()
    return group


def _membership(db: DbSession, group: Group, user_id: uuid.UUID) -> GroupMember | None:
    return db.scalar(
        select(GroupMember).where(GroupMember.group_id == group.id, GroupMember.user_id == user_id)
    )


def _active_member(db: DbSession, group_id: uuid.UUID, caller: Caller) -> tuple[Group, GroupMember]:
    """The group and the caller's live membership; anything else is 404, like any foreign row."""
    group = _group_or_404(db, group_id)
    member = _membership(db, group, caller.user.id)
    if member is None or member.left_at is not None:
        raise not_found()
    return group, member


def _require_owner(group: Group, caller: Caller) -> None:
    if group.owner_id != caller.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="owner_only")


def _members(db: DbSession, group: Group) -> list[tuple[GroupMember, User]]:
    rows = db.execute(
        select(GroupMember, User)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
        .order_by(GroupMember.joined_at, GroupMember.id)
    )
    return [(m, u) for m, u in rows]


def _member_count(db: DbSession, group: Group) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(GroupMember)
            .where(GroupMember.group_id == group.id, GroupMember.left_at.is_(None))
        )
        or 0
    )


def _member_out(member: GroupMember, user: User, group: Group, caller: Caller) -> MemberOut:
    name, initial = _shown_name(user)
    return MemberOut(
        user_id=user.id,
        display_name=name,
        initial=initial,
        progress_bps=member.progress_bps,
        reached_at=_utc(member.reached_at),
        has_events=member.progress_updated_at is not None,
        is_me=user.id == caller.user.id,
        is_owner=user.id == group.owner_id,
        former=user.deleted_at is not None,
    )


def _summary(db: DbSession, group: Group, me: GroupMember, caller: Caller) -> GroupSummary:
    return GroupSummary(
        id=group.id,
        name=group.name,
        template_key=group.template_key,
        start_date=group.start_date,
        end_date=group.end_date,
        invite_code=group.invite_code,
        is_owner=group.owner_id == caller.user.id,
        member_count=_member_count(db, group),
        my_progress_bps=me.progress_bps,
    )


def _detail(db: DbSession, group: Group, me: GroupMember, caller: Caller) -> GroupDetail:
    summary = _summary(db, group, me, caller)
    return GroupDetail(
        **summary.model_dump(),
        members=[_member_out(m, u, group, caller) for m, u in _members(db, group)],
    )


def _join(db: DbSession, group: Group, caller: Caller, request: Request) -> GroupMember:
    member = _membership(db, group, caller.user.id)
    if member is None:
        member = GroupMember(group_id=group.id, user_id=caller.user.id, joined_at=_now())
        db.add(member)
    elif member.left_at is not None:
        member.left_at = None
        member.joined_at = _now()
    else:
        return member
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.GROUP_JOINED,
        target=f"group:{group.id}",
        ip=client_ip(request),
    )
    db.flush()
    alerts_svc.group_joined(db, group, caller.user.id)
    return member


def my_groups(db: DbSession, caller: Caller) -> list[GroupSummary]:
    """Every group the caller is in, newest month first. Also what the data export includes."""
    rows = db.execute(
        select(Group, GroupMember)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_id == caller.user.id, GroupMember.left_at.is_(None))
        .order_by(Group.start_date.desc(), Group.created_at.desc())
    )
    return [_summary(db, g, m, caller) for g, m in rows]


@router.get("")
def list_groups(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> list[GroupSummary]:
    return my_groups(db, caller)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_group(
    body: CreateGroupRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupDetail:
    """Start a challenge of the chosen type; the creator is its first member."""
    require_feature(db, caller.user.id, "groups_create")  # Free joins; Private and up create
    start, end = _dates_for(body)
    group = Group(
        owner_id=caller.user.id,
        name=body.name.strip() or DEFAULT_NAMES[body.template_key],
        template_key=body.template_key,
        invite_code=_new_code(db),
        start_date=start,
        end_date=end,
    )
    db.add(group)
    db.flush()
    me = GroupMember(group_id=group.id, user_id=caller.user.id, joined_at=_now())
    db.add(me)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.GROUP_CREATED,
        target=f"group:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return _detail(db, group, me, caller)


@router.post("/lookup", dependencies=[Depends(rate_limited("invite_join"))])
def lookup_group(
    body: CodeRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupPreview:
    """What a code points at, before joining. An unknown code is 404 like any other miss."""
    group = db.scalar(select(Group).where(Group.invite_code == _normalise_code(body.code)))
    if group is None:
        raise not_found()
    owner = db.get(User, group.owner_id)
    member = _membership(db, group, caller.user.id)
    return GroupPreview(
        id=group.id,
        name=group.name,
        template_key=group.template_key,
        started_by=_shown_name(owner)[0] if owner else FORMER_MEMBER,
        start_date=group.start_date,
        end_date=group.end_date,
        member_count=_member_count(db, group),
        already_member=member is not None and member.left_at is None,
    )


@router.post("/join", dependencies=[Depends(rate_limited("invite_join"))])
def join_group(
    body: CodeRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupDetail:
    group = db.scalar(select(Group).where(Group.invite_code == _normalise_code(body.code)))
    if group is None:
        raise not_found()
    existing = _membership(db, group, caller.user.id)
    if existing is None or existing.left_at is not None:
        active = int(
            db.scalar(
                select(func.count())
                .select_from(GroupMember)
                .where(GroupMember.user_id == caller.user.id, GroupMember.left_at.is_(None))
            )
            or 0
        )
        check_limit(db, caller.user.id, "groups_join_max", active)
    me = _join(db, group, caller, request)
    db.commit()
    return _detail(db, group, me, caller)


@router.get("/{group_id}")
def group_detail(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupDetail:
    group, me = _active_member(db, group_id, caller)
    return _detail(db, group, me, caller)


@router.put("/{group_id}/progress")
def update_progress(
    group_id: uuid.UUID,
    body: ProgressRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> MemberOut:
    """The one number a device sends: percent of the member's own target. Never an amount."""
    group, me = _active_member(db, group_id, caller)
    now = _now()
    me.progress_bps = body.progress_bps
    me.progress_updated_at = now
    if body.progress_bps >= 10000 and me.reached_at is None:
        me.reached_at = now
    db.commit()
    return _member_out(me, caller.user, group, caller)


@router.post("/{group_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave_group(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> Response:
    group, me = _active_member(db, group_id, caller)
    if group.owner_id == caller.user.id:
        # Proposed: the owner keeps the group (they can remove members and regenerate the code).
        raise HTTPException(status.HTTP_409_CONFLICT, detail="owner_cannot_leave")
    me.left_at = _now()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.GROUP_LEFT,
        target=f"group:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{group_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> Response:
    """Owner only. Removing yourself is not leaving: use /leave."""
    group, _ = _active_member(db, group_id, caller)
    _require_owner(group, caller)
    if user_id == caller.user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="owner_cannot_leave")
    member = _membership(db, group, user_id)
    if member is None or member.left_at is not None:
        raise not_found()
    member.left_at = _now()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.GROUP_MEMBER_REMOVED,
        target=f"group:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{group_id}/code")
def regenerate_code(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupDetail:
    """Owner only: the old code stops working at once."""
    group, me = _active_member(db, group_id, caller)
    _require_owner(group, caller)
    group.invite_code = _new_code(db)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.GROUP_CODE_REGENERATED,
        target=f"group:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return _detail(db, group, me, caller)
