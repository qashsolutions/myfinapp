"""Split bills (docs/spec.md "Split bills"; chunk S.2; invariants 77–79).

One organizer on Private or Connected runs a group; everyone else is a free guest. The server
can't read a bill: names, amounts, splits and payment handles travel as ciphertext under a
group key made on the organizer's device. What the server decides is everything a device must
not: who is in which group, invites bound to one inbox for 7 days, the bill ids it issued (so
the daily limit holds, and a device counts only bills whose id is here), disputes, mistakes,
reports and the 3-reporter block.

- GET  /api/splits: my groups, today's count, double-check and block state, guest or not
- POST /api/splits: start a group (a plan with split_people_max > 0; not blocked)
- POST /api/splits/{id}/invites, DELETE …/invites/{invite_id}: email invites (organizer)
- POST /api/splits/invites/lookup | accept | decline: the invite card, by its token
- POST /api/splits/{id}/bills: issue a bill id against the organizer's daily limit
- GET  /api/splits/{id}/state: blobs, issued bill ids, open disputes, key handovers
- PUT  /api/splits/{id}/blobs/{kind}: my ledger, or my profile (payment handles: step-up)
- PUT  /api/splits/{id}/keys/request, PUT …/keys/{member_id}/{device_key_id}: key handover
- POST /api/splits/{id}/disputes, POST …/disputes/{bill_id}/close
- POST /api/splits/{id}/leave (optionally reporting the organizer), DELETE …/members/{member_id}
- POST /api/splits/{id}/takeover: a member with a plan runs a group whose organizer can't
- POST /api/splits/pay-consent: the pay warning's version was accepted (nothing else)
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models.billing import Subscription
from app.models.notification import NotificationSettings
from app.models.split import (
    BLOB_KINDS,
    SplitBill,
    SplitBlob,
    SplitDispute,
    SplitGroup,
    SplitInvite,
    SplitKey,
    SplitMember,
    SplitMistake,
    SplitPayConsent,
    SplitReport,
)
from app.models.user import User
from app.routers.backup import B64, decode_b64url, encode_b64url
from app.routers.groups import _shown_name
from app.rules_server.entitlements import active_subscription, effective_plan, limits_for
from app.security.audit import AuditAction, record
from app.security.authz import not_found
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.hashing import pseudonym
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import email as email_svc
from app.services.otp import canonical_email

router = APIRouter(prefix="/api/splits", tags=["splits"], dependencies=[Depends(same_site_only)])

CONFIG_PATH = Path(__file__).resolve().parent.parent / "rules_server" / "splits.yaml"
MAX_LEDGER_BYTES = 256 * 1024
MAX_PROFILE_BYTES = 4 * 1024
MAX_KEY_BYTES = 1024
BlobKind = Literal["ledger", "profile"]
ReportReason = Literal["dont_know", "not_owed", "pushy", "other"]


@lru_cache
def config() -> dict[str, Any]:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _now() -> datetime:
    return datetime.now(UTC)


def _inbox(email: str) -> str:
    """The invited inbox as a keyed hash (canonical: +tags and Gmail dots dropped, like trials)."""
    return pseudonym(canonical_email(email))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def masked_email(email: str) -> str:
    """j•••@gmail.com: enough to recognise who is asking, never the whole address."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}•••@{domain}"


def _limits(db: DbSession, user_id: uuid.UUID) -> dict[str, Any]:
    return limits_for(effective_plan(db, user_id)[0])


def _can_run(db: DbSession, user: User | None) -> bool:
    """A paid plan (or trial, or household cover) that runs split groups, and not blocked."""
    if user is None or user.deleted_at is not None or user.split_blocked_at is not None:
        return False
    return int(_limits(db, user.id).get("split_people_max") or 0) > 0


def _local_day(db: DbSession, user_id: uuid.UUID, now: datetime) -> date:
    """The organizer's own day: their notification time zone, else UTC (spec "Limits")."""
    zone = db.scalar(
        select(NotificationSettings.timezone).where(NotificationSettings.user_id == user_id)
    )
    try:
        return now.astimezone(ZoneInfo(zone or "UTC")).date()
    except (KeyError, ValueError):
        return now.date()


def _added_today(db: DbSession, user_id: uuid.UUID, day: date) -> int:
    return int(
        db.scalar(
            select(func.count(SplitBill.id)).where(
                SplitBill.counted_for == user_id, SplitBill.counted_day == day
            )
        )
        or 0
    )


def double_check(db: DbSession, user: User, now: datetime) -> bool:
    """On after `threshold` mistakes within the window; off once a window passes with none."""
    if user.split_double_check_since is None:
        return False
    window = timedelta(days=int(config()["mistakes"]["window_days"]))
    latest = db.scalar(
        select(func.max(SplitMistake.created_at)).where(SplitMistake.user_id == user.id)
    )
    if latest is None or latest <= now - window:
        user.split_double_check_since = None
        db.flush()
        return False
    return True


def record_mistake(db: DbSession, user_id: uuid.UUID | None, kind: str, now: datetime) -> None:
    if user_id is None:
        return
    db.add(SplitMistake(user_id=user_id, kind=kind, created_at=now, updated_at=now))
    db.flush()
    cfg = config()["mistakes"]
    since = now - timedelta(days=int(cfg["window_days"]))
    count = db.scalar(
        select(func.count(SplitMistake.id)).where(
            SplitMistake.user_id == user_id, SplitMistake.created_at > since
        )
    )
    user = db.get(User, user_id)
    if user is not None and int(count or 0) >= int(cfg["threshold"]):
        user.split_double_check_since = user.split_double_check_since or now
        db.flush()


def record_report(
    db: DbSession, organizer: User, reporter_id: uuid.UUID, group_id: uuid.UUID, reason: str
) -> None:
    """One report per reporter per organizer counts; `threshold` different people block."""
    cleared = organizer.split_reports_cleared_at
    counted = select(SplitReport.reporter_id).where(SplitReport.organizer_id == organizer.id)
    if cleared is not None:
        counted = counted.where(SplitReport.created_at > cleared)
    if reporter_id not in set(db.scalars(counted).all()):
        db.add(
            SplitReport(
                organizer_id=organizer.id, reporter_id=reporter_id, group_id=group_id, reason=reason
            )
        )
        db.flush()
    reporters = set(db.scalars(counted).all())
    if (
        len(reporters) >= int(config()["reports"]["threshold"])
        and organizer.split_blocked_at is None
    ):
        organizer.split_blocked_at = _now()
        db.flush()


def _group(db: DbSession, group_id: uuid.UUID) -> SplitGroup:
    group = db.get(SplitGroup, group_id)
    if group is None:
        raise not_found()
    return group


def _live_members(db: DbSession, group_id: uuid.UUID) -> list[SplitMember]:
    return list(
        db.scalars(
            select(SplitMember)
            .where(SplitMember.group_id == group_id, SplitMember.left_at.is_(None))
            .order_by(SplitMember.joined_at, SplitMember.id)
        )
    )


def _membership(db: DbSession, group: SplitGroup, user_id: uuid.UUID) -> SplitMember:
    """Not a member is 404, exactly like someone else's row."""
    member = db.scalar(
        select(SplitMember).where(
            SplitMember.group_id == group.id,
            SplitMember.user_id == user_id,
            SplitMember.left_at.is_(None),
        )
    )
    if member is None:
        raise not_found()
    return member


def _organizer_only(group: SplitGroup, caller: Caller) -> None:
    if group.organizer_id != caller.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="organizer_only")


def _pending_invites(db: DbSession, group_id: uuid.UUID, now: datetime) -> int:
    return int(
        db.scalar(
            select(func.count(SplitInvite.id)).where(
                SplitInvite.group_id == group_id,
                SplitInvite.used_at.is_(None),
                SplitInvite.declined_at.is_(None),
                SplitInvite.cancelled_at.is_(None),
                SplitInvite.expires_at > now,
            )
        )
        or 0
    )


def _people_max(db: DbSession, group: SplitGroup) -> int:
    if group.organizer_id is None:
        return 0
    return int(_limits(db, group.organizer_id).get("split_people_max") or 0)


def _writable(db: DbSession, group: SplitGroup) -> bool:
    """New bills and edits need an organizer who can run the group (spec "When the organizer's
    plan ends"): otherwise the group is view-and-settle only."""
    organizer = db.get(User, group.organizer_id) if group.organizer_id else None
    return _can_run(db, organizer)


# ---- shapes ----


class SplitMemberOut(BaseModel):
    member_id: uuid.UUID
    display_name: str
    initial: str
    is_me: bool
    is_organizer: bool
    guest: bool
    joined_at: datetime


class SplitInviteOut(BaseModel):
    id: uuid.UUID
    expires_at: datetime


class SplitGroupOut(BaseModel):
    id: uuid.UUID
    is_organizer: bool
    my_member_id: uuid.UUID
    members: list[SplitMemberOut]
    invites: list[SplitInviteOut]  # the organizer's pending ones; empty for everyone else
    people_max: int
    writable: bool  # bills and edits allowed (an organizer who can run it)
    reported: bool  # the organizer is blocked after reports: "Don't pay unless you're sure"


class TodayOut(BaseModel):
    added: int
    limit: int


class SplitsOut(BaseModel):
    groups: list[SplitGroupOut]
    can_create: bool
    guest: bool  # no plan that runs groups: the two-tab guest app
    today: TodayOut
    double_check: bool
    blocked: bool


class InviteIn(BaseModel):
    email: EmailStr
    email_again: EmailStr | None = None


class InviteCreated(BaseModel):
    id: uuid.UUID
    expires_at: datetime
    token: str  # for the "In person?" QR code; the email carries the same one


class TokenIn(BaseModel):
    token: str = Field(min_length=16, max_length=128)


class InviteCardOut(BaseModel):
    group_id: uuid.UUID
    organizer_name: str
    organizer_initial: str
    organizer_email: str  # masked: j•••@gmail.com
    member_since: str  # YYYY-MM
    pays_with_card: bool  # a live plan paid by card (US cards only)
    people: int
    expires_at: datetime


class BillIssued(BaseModel):
    id: uuid.UUID
    today: TodayOut


class SplitBlobIn(BaseModel):
    ciphertext: str = Field(min_length=1, max_length=MAX_LEDGER_BYTES * 4 // 3 + 8, pattern=B64)
    version: int = Field(ge=1)


class SplitBlobOut(BaseModel):
    member_id: uuid.UUID
    kind: str
    ciphertext: str
    version: int
    updated_at: datetime


class KeyRequestIn(BaseModel):
    device_key_id: str = Field(min_length=8, max_length=64, pattern=B64)
    public_key: str = Field(min_length=1, max_length=MAX_KEY_BYTES * 4 // 3 + 8, pattern=B64)


class WrappedKeyIn(BaseModel):
    wrapped_key: str = Field(min_length=1, max_length=MAX_KEY_BYTES * 4 // 3 + 8, pattern=B64)


class SplitKeyOut(BaseModel):
    member_id: uuid.UUID
    device_key_id: str
    public_key: str
    wrapped_key: str | None


class SplitStateOut(BaseModel):
    blobs: list[SplitBlobOut]
    bill_ids: list[uuid.UUID]
    disputes: list[DisputeOut]
    keys: list[SplitKeyOut]
    writable: bool


class DisputeOut(BaseModel):
    bill_id: uuid.UUID
    member_id: uuid.UUID | None


class DisputeIn(BaseModel):
    bill_id: uuid.UUID


class LeaveIn(BaseModel):
    report: ReportReason | None = None


class PayConsentIn(BaseModel):
    version: str = Field(min_length=1, max_length=16)


SplitStateOut.model_rebuild()


def _today(db: DbSession, user: User, now: datetime) -> TodayOut:
    limit = int(_limits(db, user.id).get("split_bills_per_day") or 0)
    return TodayOut(added=_added_today(db, user.id, _local_day(db, user.id, now)), limit=limit)


def _group_out(db: DbSession, group: SplitGroup, me: uuid.UUID, now: datetime) -> SplitGroupOut:
    members = _live_members(db, group.id)
    mine = next(m for m in members if m.user_id == me)
    out: list[SplitMemberOut] = []
    for m in members:
        person = db.get(User, m.user_id) if m.user_id else None
        name, initial = _shown_name(person) if person else ("Former member", "-")
        out.append(
            SplitMemberOut(
                member_id=m.id,
                display_name=name,
                initial=initial,
                is_me=m.user_id == me,
                is_organizer=m.user_id is not None and m.user_id == group.organizer_id,
                guest=person is None or not _can_run(db, person),
                joined_at=m.joined_at,
            )
        )
    invites: list[SplitInviteOut] = []
    if group.organizer_id == me:
        invites = [
            SplitInviteOut(id=i.id, expires_at=i.expires_at)
            for i in db.scalars(
                select(SplitInvite)
                .where(
                    SplitInvite.group_id == group.id,
                    SplitInvite.used_at.is_(None),
                    SplitInvite.declined_at.is_(None),
                    SplitInvite.cancelled_at.is_(None),
                    SplitInvite.expires_at > now,
                )
                .order_by(SplitInvite.created_at)
            )
        ]
    organizer = db.get(User, group.organizer_id) if group.organizer_id else None
    return SplitGroupOut(
        id=group.id,
        is_organizer=group.organizer_id == me,
        my_member_id=mine.id,
        members=out,
        invites=invites,
        people_max=_people_max(db, group),
        writable=_writable(db, group),
        reported=organizer is not None and organizer.split_blocked_at is not None,
    )


# ---- groups ----


@router.get("")
def list_splits(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SplitsOut:
    now = _now()
    group_ids = db.scalars(
        select(SplitMember.group_id).where(
            SplitMember.user_id == caller.user.id, SplitMember.left_at.is_(None)
        )
    ).all()
    groups = [
        _group_out(db, g, caller.user.id, now)
        for g in db.scalars(
            select(SplitGroup).where(SplitGroup.id.in_(group_ids)).order_by(SplitGroup.created_at)
        )
    ]
    runs = _can_run(db, caller.user)
    out = SplitsOut(
        groups=groups,
        can_create=runs,
        guest=int(_limits(db, caller.user.id).get("split_people_max") or 0) == 0,
        today=_today(db, caller.user, now),
        double_check=double_check(db, caller.user, now),
        blocked=caller.user.split_blocked_at is not None,
    )
    db.commit()
    return out


@router.post("", status_code=status.HTTP_201_CREATED)
def create_split(
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> SplitGroupOut:
    if caller.user.split_blocked_at is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="split_blocked")
    if not _can_run(db, caller.user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_required")
    now = _now()
    group = SplitGroup(organizer_id=caller.user.id)
    db.add(group)
    db.flush()
    db.add(SplitMember(group_id=group.id, user_id=caller.user.id, joined_at=now))
    db.flush()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.SPLIT_CREATED,
        target=f"split:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return _group_out(db, group, caller.user.id, now)


# ---- invites ----


@router.post(
    "/{group_id}/invites",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limited("split_invite", key=session_or_ip))],
)
def invite(
    group_id: uuid.UUID,
    body: InviteIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> InviteCreated:
    group = _group(db, group_id)
    _membership(db, group, caller.user.id)
    _organizer_only(group, caller)
    if caller.user.split_blocked_at is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="split_blocked")
    if not _writable(db, group):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="read_only")
    now = _now()
    inbox = _inbox(body.email)
    if inbox == _inbox(caller.user.email):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="own_email")
    if db.scalar(
        select(SplitInvite.id).where(
            SplitInvite.invited_by == caller.user.id,
            SplitInvite.email_hash == inbox,
            SplitInvite.declined_at.is_not(None),
        )
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="declined_before")
    # After 3 mistakes in 30 days the email is typed twice (spec "Mistakes"); the server checks.
    if double_check(db, caller.user, now) and (
        body.email_again is None or canonical_email(body.email_again) != canonical_email(body.email)
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="emails_differ")
    members = _live_members(db, group.id)
    for m in members:
        person = db.get(User, m.user_id) if m.user_id else None
        if person is not None and _inbox(person.email) == inbox:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="already_member")
    if len(members) + _pending_invites(db, group.id, now) >= _people_max(db, group):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_limit")
    # A new invite to the same inbox replaces the earlier one.
    db.execute(
        update(SplitInvite)
        .where(
            SplitInvite.group_id == group.id,
            SplitInvite.email_hash == inbox,
            SplitInvite.used_at.is_(None),
            SplitInvite.cancelled_at.is_(None),
        )
        .values(cancelled_at=now)
    )
    token = secrets.token_urlsafe(32)
    row = SplitInvite(
        group_id=group.id,
        invited_by=caller.user.id,
        email_hash=inbox,
        token_hash=_token_hash(token),
        expires_at=now + timedelta(days=int(config()["invites"]["ttl_days"])),
    )
    db.add(row)
    db.flush()
    name = _shown_name(caller.user)[0]
    link = f"{get_settings().origins[0]}/splits/join#t={token}"
    email_svc.get_sender().send(
        email_svc.split_invite_message(str(body.email), name, masked_email(caller.user.email), link)
    )
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.SPLIT_INVITED,
        target=f"split:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return InviteCreated(id=row.id, expires_at=row.expires_at, token=token)


@router.delete("/{group_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_invite(
    group_id: uuid.UUID,
    invite_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    group = _group(db, group_id)
    _membership(db, group, caller.user.id)
    _organizer_only(group, caller)
    row = db.get(SplitInvite, invite_id)
    if row is None or row.group_id != group.id:
        raise not_found()
    row.cancelled_at = row.cancelled_at or _now()
    db.commit()


def _open_invite(db: DbSession, token: str, caller: Caller, now: datetime) -> SplitInvite:
    """The invite for this token, for this caller's inbox only, unused and in date."""
    row = db.scalar(
        select(SplitInvite).where(SplitInvite.token_hash == _token_hash(token)).with_for_update()
    )
    if (
        row is None
        or row.used_at is not None
        or row.declined_at is not None
        or row.cancelled_at is not None
        or row.expires_at <= now
    ):
        raise not_found()
    if row.email_hash != _inbox(caller.user.email):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="other_email")
    return row


@router.post("/invites/lookup", dependencies=[Depends(rate_limited("invite_join"))])
def lookup_invite(
    body: TokenIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> InviteCardOut:
    now = _now()
    row = _open_invite(db, body.token, caller, now)
    group = _group(db, row.group_id)
    organizer = db.get(User, group.organizer_id) if group.organizer_id else None
    if organizer is None or organizer.deleted_at is not None:
        raise not_found()
    sub: Subscription | None = active_subscription(db, organizer.id, now=now)
    name, initial = _shown_name(organizer)
    return InviteCardOut(
        group_id=group.id,
        organizer_name=name,
        organizer_initial=initial,
        organizer_email=masked_email(organizer.email),
        member_since=organizer.created_at.strftime("%Y-%m"),
        pays_with_card=sub is not None and sub.source == "stripe",
        people=len(_live_members(db, group.id)),
        expires_at=row.expires_at,
    )


@router.post("/invites/accept", dependencies=[Depends(rate_limited("invite_join"))])
def accept_invite(
    body: TokenIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> SplitGroupOut:
    now = _now()
    row = _open_invite(db, body.token, caller, now)
    group = db.scalar(select(SplitGroup).where(SplitGroup.id == row.group_id).with_for_update())
    if group is None:
        raise not_found()
    members = _live_members(db, group.id)
    if any(m.user_id == caller.user.id for m in members):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_member")
    # The invite itself held a place; still never past the organizer's limit today.
    if len(members) >= _people_max(db, group):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_limit")
    db.add(SplitMember(group_id=group.id, user_id=caller.user.id, joined_at=now))
    row.used_at = now
    row.used_by = caller.user.id
    db.flush()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.SPLIT_JOINED,
        target=f"split:{group.id}",
        ip=client_ip(request),
    )
    db.commit()
    return _group_out(db, group, caller.user.id, now)


@router.post(
    "/invites/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("invite_join"))],
)
def decline_invite(
    body: TokenIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """ "I don't know <name>": nobody is added, that sender can't invite this inbox again, and it
    counts as one of the sender's mistakes (spec "Mistakes")."""
    now = _now()
    row = _open_invite(db, body.token, caller, now)
    row.declined_at = now
    record_mistake(db, row.invited_by, "invite_declined", now)
    db.commit()


# ---- bills, ledger and keys ----


@router.post("/{group_id}/bills", status_code=status.HTTP_201_CREATED)
def issue_bill(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> BillIssued:
    """One bill id against the organizer's daily limit; a guest's bill counts for the organizer
    (spec "Limits"). Edits, deletes, settling up and repeats never call this."""
    group = db.scalar(select(SplitGroup).where(SplitGroup.id == group_id).with_for_update())
    if group is None:
        raise not_found()
    _membership(db, group, caller.user.id)
    if not _writable(db, group):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="read_only")
    organizer = db.get(User, group.organizer_id)
    assert organizer is not None  # _writable
    # One count at a time per organizer, whichever of their groups asks.
    db.execute(select(User.id).where(User.id == organizer.id).with_for_update())
    now = _now()
    day = _local_day(db, organizer.id, now)
    limit = int(_limits(db, organizer.id).get("split_bills_per_day") or 0)
    added = _added_today(db, organizer.id, day)
    if added >= limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="daily_limit")
    bill = SplitBill(
        group_id=group.id, created_by=caller.user.id, counted_for=organizer.id, counted_day=day
    )
    db.add(bill)
    db.flush()
    db.commit()
    return BillIssued(id=bill.id, today=TodayOut(added=added + 1, limit=limit))


@router.get("/{group_id}/state")
def state(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SplitStateOut:
    group = _group(db, group_id)
    me = _membership(db, group, caller.user.id)
    blobs = [
        SplitBlobOut(
            member_id=b.member_id,
            kind=b.kind,
            ciphertext=encode_b64url(b.ciphertext),
            version=b.version,
            updated_at=b.updated_at,
        )
        for b in db.scalars(
            select(SplitBlob)
            .where(SplitBlob.group_id == group.id)
            .order_by(SplitBlob.kind, SplitBlob.member_id)
        )
    ]
    member_of = {
        m.user_id: m.id
        for m in db.scalars(select(SplitMember).where(SplitMember.group_id == group.id))
        if m.user_id is not None
    }
    disputes = [
        DisputeOut(bill_id=d.bill_id, member_id=member_of.get(d.user_id) if d.user_id else None)
        for d in db.scalars(
            select(SplitDispute)
            .where(SplitDispute.group_id == group.id, SplitDispute.closed_at.is_(None))
            .order_by(SplitDispute.created_at)
        )
    ]
    # A device sees requests from everyone (to wrap the key for them) and its own wrapped key.
    keys = [
        SplitKeyOut(
            member_id=k.member_id,
            device_key_id=k.device_key_id,
            public_key=encode_b64url(k.public_key),
            wrapped_key=encode_b64url(k.wrapped_key)
            if k.wrapped_key is not None and k.member_id == me.id
            else None,
        )
        for k in db.scalars(
            select(SplitKey).where(SplitKey.group_id == group.id).order_by(SplitKey.created_at)
        )
    ]
    bill_ids = list(
        db.scalars(
            select(SplitBill.id)
            .where(SplitBill.group_id == group.id)
            .order_by(SplitBill.created_at, SplitBill.id)
        )
    )
    return SplitStateOut(
        blobs=blobs, bill_ids=bill_ids, disputes=disputes, keys=keys, writable=_writable(db, group)
    )


def _put_blob(db: DbSession, group: SplitGroup, member: SplitMember, kind: str, body: SplitBlobIn):
    assert kind in BLOB_KINDS
    limit = MAX_PROFILE_BYTES if kind == "profile" else MAX_LEDGER_BYTES
    data = decode_b64url(body.ciphertext, max_bytes=limit)
    row = db.scalar(
        select(SplitBlob).where(
            SplitBlob.group_id == group.id,
            SplitBlob.member_id == member.id,
            SplitBlob.kind == kind,
        )
    )
    if row is None:
        row = SplitBlob(
            group_id=group.id, member_id=member.id, kind=kind, ciphertext=data, version=body.version
        )
        db.add(row)
    else:
        if body.version <= row.version:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="stale_version")
        row.ciphertext = data
        row.version = body.version
        row.updated_at = _now()
    db.flush()
    db.commit()


@router.put("/{group_id}/blobs/ledger", status_code=status.HTTP_204_NO_CONTENT)
def put_ledger(
    group_id: uuid.UUID,
    body: SplitBlobIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    group = _group(db, group_id)
    member = _membership(db, group, caller.user.id)
    _put_blob(db, group, member, "ledger", body)


@router.put("/{group_id}/blobs/profile", status_code=status.HTTP_204_NO_CONTENT)
def put_profile(
    group_id: uuid.UUID,
    body: SplitBlobIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """Payment handles: only their owner saves them, after Face ID (spec "Payment handles")."""
    group = _group(db, group_id)
    member = _membership(db, group, caller.user.id)
    _put_blob(db, group, member, "profile", body)


@router.put("/{group_id}/keys/request", status_code=status.HTTP_204_NO_CONTENT)
def request_key(
    group_id: uuid.UUID,
    body: KeyRequestIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    group = _group(db, group_id)
    member = _membership(db, group, caller.user.id)
    public = decode_b64url(body.public_key, max_bytes=MAX_KEY_BYTES)
    row = db.scalar(
        select(SplitKey).where(
            SplitKey.group_id == group.id,
            SplitKey.member_id == member.id,
            SplitKey.device_key_id == body.device_key_id,
        )
    )
    if row is None:
        db.add(
            SplitKey(
                group_id=group.id,
                member_id=member.id,
                device_key_id=body.device_key_id,
                public_key=public,
            )
        )
    elif row.public_key != public:
        row.public_key = public
        row.wrapped_key = None  # a new public key needs a new wrap
        row.wrapped_by = None
    db.commit()


@router.put("/{group_id}/keys/{member_id}/{device_key_id}", status_code=status.HTTP_204_NO_CONTENT)
def wrap_key(
    group_id: uuid.UUID,
    member_id: uuid.UUID,
    device_key_id: str,
    body: WrappedKeyIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    group = _group(db, group_id)
    me = _membership(db, group, caller.user.id)
    row = db.scalar(
        select(SplitKey).where(
            SplitKey.group_id == group.id,
            SplitKey.member_id == member_id,
            SplitKey.device_key_id == device_key_id,
        )
    )
    target = db.get(SplitMember, member_id)
    if row is None or target is None or target.left_at is not None:
        raise not_found()
    if row.wrapped_key is None:  # the first wrap wins; a member can't swap someone's key
        row.wrapped_key = decode_b64url(body.wrapped_key, max_bytes=MAX_KEY_BYTES)
        row.wrapped_by = me.id
    db.commit()


# ---- disputes ----


@router.post("/{group_id}/disputes", status_code=status.HTTP_204_NO_CONTENT)
def dispute(
    group_id: uuid.UUID,
    body: DisputeIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """A bill on hold for everyone until fixed; a mistake against whoever added it."""
    group = _group(db, group_id)
    _membership(db, group, caller.user.id)
    bill = db.get(SplitBill, body.bill_id)
    if bill is None or bill.group_id != group.id:
        raise not_found()
    if db.scalar(
        select(SplitDispute.id).where(
            SplitDispute.bill_id == bill.id,
            SplitDispute.user_id == caller.user.id,
            SplitDispute.closed_at.is_(None),
        )
    ):
        return
    now = _now()
    db.add(SplitDispute(group_id=group.id, bill_id=bill.id, user_id=caller.user.id))
    if bill.created_by != caller.user.id:
        record_mistake(db, bill.created_by, "bill_disputed", now)
    db.commit()


@router.post("/{group_id}/disputes/{bill_id}/close", status_code=status.HTTP_204_NO_CONTENT)
def close_dispute(
    group_id: uuid.UUID,
    bill_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """The organizer fixed the bill (closes every dispute on it), or a disputer withdraws."""
    group = _group(db, group_id)
    _membership(db, group, caller.user.id)
    rows = db.scalars(
        select(SplitDispute).where(
            SplitDispute.group_id == group.id,
            SplitDispute.bill_id == bill_id,
            SplitDispute.closed_at.is_(None),
        )
    ).all()
    if group.organizer_id != caller.user.id:
        rows = [r for r in rows if r.user_id == caller.user.id]
    if not rows:
        raise not_found()
    now = _now()
    for r in rows:
        r.closed_at = now
    db.commit()


# ---- people ----


def _leave(db: DbSession, group: SplitGroup, member: SplitMember, now: datetime) -> None:
    member.left_at = now
    db.execute(update(SplitKey).where(SplitKey.member_id == member.id).values(wrapped_key=None))
    db.flush()
    if not _live_members(db, group.id):
        db.delete(group)
    elif group.organizer_id == member.user_id:
        group.organizer_id = None  # view-and-settle until someone with a plan takes over


@router.post("/{group_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave(
    group_id: uuid.UUID,
    body: LeaveIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """Leaving never forgives anything: the leaver's bills stay with the group. "Report and
    leave" adds one report against the organizer (spec "Reports and blocks")."""
    group = _group(db, group_id)
    member = _membership(db, group, caller.user.id)
    now = _now()
    if body.report is not None and group.organizer_id not in (None, caller.user.id):
        organizer = db.get(User, group.organizer_id)
        if organizer is not None:
            record_report(db, organizer, caller.user.id, group.id, body.report)
            record(
                db,
                actor_id=caller.user.id,
                action=AuditAction.SPLIT_REPORTED,
                target=f"user:{organizer.id}",
                ip=client_ip(request),
            )
    _leave(db, group, member, now)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.SPLIT_LEFT,
        target=f"split:{group.id}",
        ip=client_ip(request),
    )
    db.commit()


@router.delete("/{group_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    group_id: uuid.UUID,
    member_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """The organizer removes someone; the device checks the balance first ("Settle first")."""
    group = _group(db, group_id)
    _membership(db, group, caller.user.id)
    _organizer_only(group, caller)
    target = db.get(SplitMember, member_id)
    if target is None or target.group_id != group.id or target.left_at is not None:
        raise not_found()
    if target.user_id == caller.user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="organizer_cannot_remove_self")
    target.removed = True
    _leave(db, group, target, _now())
    db.commit()


@router.post("/{group_id}/takeover")
def takeover(
    group_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SplitGroupOut:
    """ "Run this group": a member with a plan, when the organizer can't (spec "When the
    organizer's plan ends")."""
    group = db.scalar(select(SplitGroup).where(SplitGroup.id == group_id).with_for_update())
    if group is None:
        raise not_found()
    _membership(db, group, caller.user.id)
    if _writable(db, group):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="organizer_active")
    if not _can_run(db, caller.user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_required")
    if len(_live_members(db, group.id)) > int(
        _limits(db, caller.user.id).get("split_people_max") or 0
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_limit")
    group.organizer_id = caller.user.id
    db.commit()
    return _group_out(db, group, caller.user.id, _now())


@router.post("/pay-consent", status_code=status.HTTP_204_NO_CONTENT)
def pay_consent(
    body: PayConsentIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """The person ticked both boxes on "Check first": the warning's version and the time only;
    who and how much stay on the device (invariant 78)."""
    if body.version != str(config()["pay_warning"]["version"]):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="warning_changed")
    db.add(SplitPayConsent(user_id=caller.user.id, version=body.version))
    db.commit()


def leave_all(db: DbSession, user_id: uuid.UUID, *, now: datetime | None = None) -> int:
    """Account deletion: leave every split group (bills stay, as a former member's)."""
    now = now or _now()
    count = 0
    for member in db.scalars(
        select(SplitMember).where(SplitMember.user_id == user_id, SplitMember.left_at.is_(None))
    ).all():
        group = db.get(SplitGroup, member.group_id)
        if group is not None:
            _leave(db, group, member, now)
            count += 1
    return count
