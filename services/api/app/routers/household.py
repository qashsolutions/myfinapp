"""Couples & household (docs/spec.md "Couples & household"): a household of two on Connected.

The household key is made on the inviter's device and travels in the invite link's fragment,
never here. The server keeps who is in the household, a short-lived invite code, and
ciphertext blobs (shared jars with who added what; the optional month totals) it cannot read.

- GET /api/household: the household (members, pending invite) or null; whether the plan allows one
- POST /api/household/invites: start a household if needed and issue a code (Connected)
- POST /api/household/lookup: who is inviting (the code only)
- POST /api/household/join: join with the code (the owner's plan covers the partner)
- POST /api/household/leave: leave; own blobs go; an empty household is removed
- GET /api/household/blobs, PUT /api/household/blobs/{kind}: ciphertext per author and kind
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.household import (
    BLOB_KINDS,
    MAX_MEMBERS,
    Household,
    HouseholdBlob,
    HouseholdInvite,
    HouseholdMember,
)
from app.models.user import User
from app.routers.backup import B64, decode_b64url, encode_b64url
from app.routers.groups import CODE_ALPHABET, _shown_name
from app.rules_server.entitlements import entitlements, require_feature
from app.security.audit import AuditAction, record
from app.security.authz import not_found
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_unlocked
from app.security.rate_limit import rate_limited

router = APIRouter(
    prefix="/api/household", tags=["household"], dependencies=[Depends(same_site_only)]
)

CODE_RE = re.compile(r"^HH-[A-Z0-9]{6}$")
INVITE_TTL = timedelta(days=7)
MAX_BLOB_BYTES = 64 * 1024
BlobKind = Literal["jars", "summary"]


class HouseholdMemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initial: str
    is_me: bool
    joined_at: datetime


class InviteOut(BaseModel):
    code: str
    expires_at: datetime


class HouseholdOut(BaseModel):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime
    members: list[HouseholdMemberOut]
    invite: InviteOut | None


class HouseholdStatus(BaseModel):
    household: HouseholdOut | None
    available: bool  # the caller's plan allows starting one


class CodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=12)


class PreviewOut(BaseModel):
    invited_by: str
    initial: str
    expires_at: datetime


class HouseholdBlobIn(BaseModel):
    ciphertext: str = Field(min_length=1, max_length=MAX_BLOB_BYTES * 4 // 3 + 8, pattern=B64)
    version: int = Field(ge=1)


class HouseholdBlobOut(BaseModel):
    author_id: uuid.UUID
    kind: str
    ciphertext: str
    version: int
    updated_at: datetime


class BlobSaved(BaseModel):
    kind: str
    version: int
    updated_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def _normalise_code(code: str) -> str:
    code = code.strip().upper().replace(" ", "")
    if not CODE_RE.fullmatch(code):
        raise not_found()
    return code


def _new_code(db: DbSession) -> str:
    while True:
        code = "HH-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if db.scalar(select(HouseholdInvite.id).where(HouseholdInvite.code == code)) is None:
            return code


def _membership(db: DbSession, user_id: uuid.UUID) -> HouseholdMember | None:
    return db.scalar(
        select(HouseholdMember).where(
            HouseholdMember.user_id == user_id, HouseholdMember.left_at.is_(None)
        )
    )


def _active_members(db: DbSession, household_id: uuid.UUID) -> list[HouseholdMember]:
    return list(
        db.scalars(
            select(HouseholdMember)
            .where(HouseholdMember.household_id == household_id, HouseholdMember.left_at.is_(None))
            .order_by(HouseholdMember.joined_at, HouseholdMember.id)
        )
    )


def _pending_invite(
    db: DbSession, household_id: uuid.UUID, now: datetime
) -> HouseholdInvite | None:
    return db.scalar(
        select(HouseholdInvite)
        .where(
            HouseholdInvite.household_id == household_id,
            HouseholdInvite.used_at.is_(None),
            HouseholdInvite.expires_at > now,
        )
        .order_by(HouseholdInvite.created_at.desc())
    )


def _out(db: DbSession, household: Household, me: uuid.UUID) -> HouseholdOut:
    now = _now()
    members = []
    for m in _active_members(db, household.id):
        user = db.get(User, m.user_id)
        name, initial = _shown_name(user) if user else ("Former member", "-")
        members.append(
            HouseholdMemberOut(
                user_id=m.user_id,
                display_name=name,
                initial=initial,
                is_me=m.user_id == me,
                joined_at=m.joined_at,
            )
        )
    invite = _pending_invite(db, household.id, now) if len(members) < MAX_MEMBERS else None
    return HouseholdOut(
        id=household.id,
        owner_id=household.owner_id,
        created_at=household.created_at,
        members=members,
        invite=InviteOut(code=invite.code, expires_at=invite.expires_at) if invite else None,
    )


def _my_household(db: DbSession, caller: Caller) -> Household:
    membership = _membership(db, caller.user.id)
    household = db.get(Household, membership.household_id) if membership else None
    if household is None:
        raise not_found()
    return household


def _owner_plan_allows(db: DbSession, household: Household) -> None:
    if not entitlements(db, household.owner_id).get("household"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_required")


@router.get("")
def household_status(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> HouseholdStatus:
    membership = _membership(db, caller.user.id)
    household = db.get(Household, membership.household_id) if membership else None
    return HouseholdStatus(
        household=_out(db, household, caller.user.id) if household else None,
        available=bool(entitlements(db, caller.user.id).get("household")),
    )


@router.post("/invites", status_code=status.HTTP_201_CREATED)
def invite(
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> InviteOut:
    require_feature(db, caller.user.id, "household")
    now = _now()
    membership = _membership(db, caller.user.id)
    if membership is None:
        household = Household(owner_id=caller.user.id)
        db.add(household)
        db.flush()
        db.add(HouseholdMember(household_id=household.id, user_id=caller.user.id, joined_at=now))
        db.flush()
    else:
        household = db.get(Household, membership.household_id)
        assert household is not None
    if len(_active_members(db, household.id)) >= MAX_MEMBERS:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="household_full")
    db.execute(
        delete(HouseholdInvite).where(
            HouseholdInvite.household_id == household.id, HouseholdInvite.used_at.is_(None)
        )
    )
    row = HouseholdInvite(
        household_id=household.id, code=_new_code(db), expires_at=now + INVITE_TTL
    )
    db.add(row)
    db.flush()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.HOUSEHOLD_INVITED,
        target=f"household:{household.id}",
        ip=client_ip(request),
    )
    db.commit()
    return InviteOut(code=row.code, expires_at=row.expires_at)


def _valid_invite(db: DbSession, code: str, now: datetime) -> HouseholdInvite:
    row = db.scalar(select(HouseholdInvite).where(HouseholdInvite.code == _normalise_code(code)))
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise not_found()
    return row


@router.post("/lookup", dependencies=[Depends(rate_limited("invite_join"))])
def lookup(
    body: CodeRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PreviewOut:
    row = _valid_invite(db, body.code, _now())
    household = db.get(Household, row.household_id)
    owner = db.get(User, household.owner_id) if household else None
    name, initial = _shown_name(owner) if owner else ("Former member", "-")
    return PreviewOut(invited_by=name, initial=initial, expires_at=row.expires_at)


@router.post("/join", dependencies=[Depends(rate_limited("invite_join"))])
def join(
    body: CodeRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> HouseholdOut:
    now = _now()
    if _membership(db, caller.user.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_in_household")
    row = _valid_invite(db, body.code, now)
    household = db.get(Household, row.household_id)
    if household is None:
        raise not_found()
    _owner_plan_allows(db, household)
    if len(_active_members(db, household.id)) >= MAX_MEMBERS:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="household_full")
    db.add(HouseholdMember(household_id=household.id, user_id=caller.user.id, joined_at=now))
    row.used_by = caller.user.id
    row.used_at = now
    db.flush()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.HOUSEHOLD_JOINED,
        target=f"household:{household.id}",
        ip=client_ip(request),
    )
    db.commit()
    return _out(db, household, caller.user.id)


def leave_households(db: DbSession, user_id: uuid.UUID, *, now: datetime | None = None) -> int:
    """Leave every household (one at most): own blobs go, an empty household is removed."""
    now = now or _now()
    count = 0
    for m in db.scalars(
        select(HouseholdMember).where(
            HouseholdMember.user_id == user_id, HouseholdMember.left_at.is_(None)
        )
    ).all():
        m.left_at = now
        db.execute(
            delete(HouseholdBlob).where(
                HouseholdBlob.household_id == m.household_id, HouseholdBlob.author_id == user_id
            )
        )
        db.flush()
        if not _active_members(db, m.household_id):
            household = db.get(Household, m.household_id)
            if household is not None:
                db.delete(household)
        count += 1
    db.flush()
    return count


@router.post("/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave(
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    household = _my_household(db, caller)
    leave_households(db, caller.user.id)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.HOUSEHOLD_LEFT,
        target=f"household:{household.id}",
        ip=client_ip(request),
    )
    db.commit()


@router.get("/blobs")
def list_blobs(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> list[HouseholdBlobOut]:
    household = _my_household(db, caller)
    rows = db.scalars(
        select(HouseholdBlob)
        .where(HouseholdBlob.household_id == household.id)
        .order_by(HouseholdBlob.kind, HouseholdBlob.author_id)
    )
    return [
        HouseholdBlobOut(
            author_id=r.author_id,
            kind=r.kind,
            ciphertext=encode_b64url(r.ciphertext),
            version=r.version,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.put("/blobs/{kind}")
def put_blob(
    kind: BlobKind,
    body: HouseholdBlobIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> BlobSaved:
    household = _my_household(db, caller)
    _owner_plan_allows(db, household)
    assert kind in BLOB_KINDS
    data = decode_b64url(body.ciphertext, max_bytes=MAX_BLOB_BYTES)
    row = db.scalar(
        select(HouseholdBlob).where(
            HouseholdBlob.household_id == household.id,
            HouseholdBlob.author_id == caller.user.id,
            HouseholdBlob.kind == kind,
        )
    )
    if row is None:
        row = HouseholdBlob(
            household_id=household.id,
            author_id=caller.user.id,
            kind=kind,
            ciphertext=data,
            version=body.version,
        )
        db.add(row)
    else:
        row.ciphertext = data
        row.version = body.version
        row.updated_at = _now()
    db.flush()
    db.commit()
    db.refresh(row)
    return BlobSaved(kind=row.kind, version=row.version, updated_at=row.updated_at)
