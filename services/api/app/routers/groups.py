"""Groups: the monthly savings challenge (docs/spec.md "Groups").

Each member saves toward their own target for the calendar month and is ranked by percent of
that target. The target and every deposit stay on the member's device: the server holds the
group's name, dates and invite code, who is in it, and one percentage per member. Members see
display names and initials only, never emails or amounts. The leaderboard order itself is the
`groups.rank` rule, run on the device over what this router returns.
"""

from __future__ import annotations

import calendar
import json
import re
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta
from importlib import resources
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
from app.security.rate_limit import rate_limited, session_or_ip
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
MAX_START_AHEAD_DAYS = 31  # a challenge starts today or within a month (signed off Oct 27, 2026)

# "What helped" (October 28, 2026; signed off October 29, 2026): the one fixed list, shared with
# the app.
_HELPED = json.loads(
    resources.files("stackd_rules").joinpath("config/helped.json").read_text(encoding="utf-8")
)
HELPED_IDS: tuple[str, ...] = tuple(c["id"] for c in _HELPED["choices"])
HELPED_MAX: int = _HELPED["max_choices"]
# Answers from members other than the caller needed before the caller sees totals (invariant 29):
# counting the caller's own would let one of two answerers take hers away and read the other's.
HELPED_MIN_ANSWERS: int = _HELPED["min_answers"]


class CreateGroupRequest(BaseModel):
    name: str = Field(default="", max_length=60)  # empty: the template's own name
    template_key: TemplateKey = "monthly_savings"
    month: str | None = Field(default=None, pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")  # monthly kinds
    start_date: date | None = None  # week, weekend and 52-week kinds: the member's local date


class CodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=12)


class ProgressRequest(BaseModel):
    progress_bps: int = Field(ge=0, le=MAX_PROGRESS_BPS)


class HelpedRequest(BaseModel):
    choices: list[str] = Field(max_length=8)


class HelpedTotals(BaseModel):
    """How many members answered and how many picked each choice: never who picked what."""

    answered: int
    counts: dict[str, int]


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
    my_helped: list[str]  # the caller's own "What helped" answer (also in their export)


class GroupDetail(GroupSummary):
    members: list[MemberOut]
    helped_open: bool  # the caller may answer: reached their target, or the challenge ended
    helped: HelpedTotals | None  # once HELPED_MIN_ANSWERS members other than the caller answered


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
        select(GroupMember)
        .where(GroupMember.group_id == group.id, GroupMember.user_id == user_id)
        .execution_options(populate_existing=True)
    )


def _lock_person(db: DbSession, user_id: uuid.UUID) -> None:
    """The lock order for joining (invariant 46, October 29, 2026): the person, then the group,
    held to the commit. One person's joins run one at a time, so the count against
    `groups_join_max` and the row it allows are one step; the same order as the household's
    joins and every deletion path."""
    db.execute(select(User.id).where(User.id == user_id).with_for_update())


def _lock_group(db: DbSession, group_id: uuid.UUID) -> Group | None:
    """Joins, removals and leaves of one group run one at a time: two joins of the same group
    at once answer the same membership instead of the second hitting the unique constraint."""
    return db.scalar(
        select(Group)
        .where(Group.id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _refuse_removed(member: GroupMember | None) -> None:
    """Invariant 45 (October 29, 2026): someone the owner removed stays out, whatever code they
    hold, the old one or a new one. Someone who left on their own may come back."""
    if member is not None and member.removed_at is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="removed")


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


def _final_from(group: Group) -> datetime:
    """When the result is final: the moment the last day is over somewhere (midnight at UTC+14,
    10:00 UTC on the last day). From then on leaving takes the challenge off the leaver's own
    list only; their standing stays on everyone else's final board (owner decision, October
    29, 2026; invariant 71), and nobody can be removed from it."""
    return datetime.combine(group.end_date, datetime.min.time(), tzinfo=UTC) + timedelta(hours=10)


def _final(group: Group, now: datetime | None = None) -> bool:
    return (now or _now()) >= _final_from(group)


def _on_board(group: Group):
    """Who the board shows: members still in, and anyone who left once the result was final."""
    return GroupMember.left_at.is_(None) | (GroupMember.left_at >= _final_from(group))


def _members(db: DbSession, group: Group) -> list[tuple[GroupMember, User]]:
    rows = db.execute(
        select(GroupMember, User)
        .join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group.id, _on_board(group))
        .order_by(GroupMember.joined_at, GroupMember.id)
    )
    return [(m, u) for m, u in rows]


def _member_count(db: DbSession, group: Group) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(GroupMember)
            .where(GroupMember.group_id == group.id, _on_board(group))
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
        my_helped=_helped_list(me),
    )


def _helped_list(member: GroupMember) -> list[str]:
    return member.helped.split(",") if member.helped else []


def _ended(group: Group, now: datetime | None = None) -> bool:
    """A challenge is over once its last day (`end_date`, a local date) is over everywhere: from
    noon UTC the day after, when it ends at UTC-12 (invariant 56). Every type has an end date:
    the calendar month, the week, the weekend, the 52 weeks. After that nobody can look it up
    or join (409 `ended`); members keep its final board."""
    now = now or _now()
    over = datetime.combine(group.end_date + timedelta(days=1), datetime.min.time(), tzinfo=UTC)
    return now >= over + timedelta(hours=12)


def _refuse_ended(group: Group) -> None:
    if _ended(group):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="ended")


def _started(group: Group, now: datetime | None = None) -> bool:
    """A challenge has started once its first day (`start_date`, a local date) has begun
    somewhere: from 10:00 UTC the day before, when it starts at UTC+14 (invariant 71)."""
    now = now or _now()
    begins = datetime.combine(group.start_date, datetime.min.time(), tzinfo=UTC)
    return now >= begins - timedelta(hours=14)


def _refuse_outside(group: Group, now: datetime) -> None:
    """Progress counts only while the challenge runs somewhere (invariant 71): before its first
    day has begun anywhere (409 `not_started`) or once its last day is over everywhere (409
    `ended`), a post changes nothing on the board, `reached_at` included. A device sends nothing
    after its own last day, so a late post the server takes is the last day's."""
    if not _started(group, now):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="not_started")
    if _ended(group, now):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="ended")


def _helped_open(group: Group, me: GroupMember) -> bool:
    return me.reached_at is not None or me.progress_bps >= 10000 or _now().date() > group.end_date


def _helped_totals(members: list[tuple[GroupMember, User]], me: GroupMember) -> HelpedTotals | None:
    answers = [_helped_list(m) for m, _ in members if m.helped]
    others = sum(1 for m, _ in members if m.helped and m.user_id != me.user_id)
    if others < HELPED_MIN_ANSWERS:
        return None
    counts = {cid: sum(cid in a for a in answers) for cid in HELPED_IDS}
    return HelpedTotals(answered=len(answers), counts={k: v for k, v in counts.items() if v})


def _detail(db: DbSession, group: Group, me: GroupMember, caller: Caller) -> GroupDetail:
    summary = _summary(db, group, me, caller)
    members = _members(db, group)
    return GroupDetail(
        **summary.model_dump(),
        members=[_member_out(m, u, group, caller) for m, u in members],
        helped_open=_helped_open(group, me),
        helped=_helped_totals(members, me),
    )


def _join(db: DbSession, group: Group, caller: Caller, request: Request) -> GroupMember:
    member = _membership(db, group, caller.user.id)
    if member is None:
        member = GroupMember(group_id=group.id, user_id=caller.user.id, joined_at=_now())
        db.add(member)
    elif member.left_at is not None:
        member.left_at = None
        member.joined_at = _now()
        member.helped = None  # a fresh start: an answer from before leaving never comes back
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
    _refuse_removed(member)
    _refuse_ended(group)
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
    code = _normalise_code(body.code)
    found = db.scalar(select(Group.id).where(Group.invite_code == code))
    if found is None:
        raise not_found()
    # Invariant 46: the count and the row it allows happen under the person's lock, then the
    # group's; read again under them (a new code, a removal or a join may have landed meanwhile).
    _lock_person(db, caller.user.id)
    group = _lock_group(db, found)
    if group is None or group.invite_code != code:
        raise not_found()
    existing = _membership(db, group, caller.user.id)
    _refuse_removed(existing)
    if existing is None or existing.left_at is not None:
        _refuse_ended(group)  # a member already in keeps the board; nobody new comes in
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
    _refuse_outside(group, now)
    me.progress_bps = body.progress_bps
    me.progress_updated_at = now
    if body.progress_bps >= 10000 and me.reached_at is None:
        me.reached_at = now
    db.commit()
    return _member_out(me, caller.user, group, caller)


@router.put(
    "/{group_id}/helped",
    dependencies=[Depends(rate_limited("group_helped", key=session_or_ip))],
)
def update_helped(
    group_id: uuid.UUID,
    body: HelpedRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> GroupDetail:
    """The member's own "What helped": up to 5 ids from the fixed list; [] clears it. Open once
    they reached their target or the challenge ended (409 not_yet before)."""
    group, me = _active_member(db, group_id, caller)
    choices = list(dict.fromkeys(body.choices))
    if len(choices) > HELPED_MAX or any(c not in HELPED_IDS for c in choices):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_choices")
    if not _helped_open(group, me):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="not_yet")
    # Stored in the list's own order, so the same answer is the same row whatever order it came.
    me.helped = ",".join(c for c in HELPED_IDS if c in choices) or None
    db.commit()
    return _detail(db, group, me, caller)


@router.post("/{group_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave_group(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> Response:
    _lock_person(db, caller.user.id)
    group, me = _active_member(db, group_id, caller)
    _lock_group(db, group.id)
    if group.owner_id == caller.user.id:
        # Signed off Oct 27, 2026: the owner keeps the group (they can remove members and
        # regenerate the code).
        raise HTTPException(status.HTTP_409_CONFLICT, detail="owner_cannot_leave")
    now = _now()
    me.left_at = now
    if not _final(group, now):
        me.helped = None  # a former member's answer leaves the totals, never back on rejoin
    # Once the result is final the leaver keeps their place, and their answer, on the board.
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
    if _final(group):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="ended")  # the result is final
    _lock_group(db, group.id)
    member = _membership(db, group, user_id)
    if member is None or member.left_at is not None:
        raise not_found()
    now = _now()
    member.left_at = now
    member.removed_at = now  # invariant 45: removed is not left; no code lets them back
    member.helped = None  # as on leaving
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
