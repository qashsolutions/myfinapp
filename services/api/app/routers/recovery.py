"""Getting back in without a passkey (owner decision, October 30, 2026; docs/spec.md "Getting
back in"; invariant 74). The rules are in `services/recovery`; these routes only call them.

The person (signed in with an email code, locked, every passkey lost):
- GET  /api/auth/recovery: none, waiting (with when it is ready) or ready; whether their
  partner can approve, by name
- POST /api/auth/recovery: start (24 hours), or the one already waiting
- POST /api/auth/recovery/partner: a code to read to the partner, who approves at once
- POST /api/auth/recovery/cancel: "I found my passkey" from the asking device, or Cancel from
  any device signed in and unlocked
Then the usual passkey registration adds the new passkey (`security._may_register`).

The partner (signed in, unlocked):
- GET  /api/household/recovery: requests their partner asked them to approve
- POST /api/household/recovery/approve: type the code (a fresh passkey check first)

The person, while they still have a passkey:
- GET / PUT /api/account/recovery-partner: "Let <partner> help me get back in"
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.user import User
from app.security.audit import AuditAction, record
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_session, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import ops_alerts
from app.services import recovery as recovery_svc
from app.services.alerts import RECOVERY_PARTNER_LABEL, RECOVERY_STARTED_LABEL
from app.services.security_alerts import SecurityEvent, send_alert

log = logging.getLogger("stackd.recovery")

router = APIRouter(tags=["recovery"], dependencies=[Depends(same_site_only)])


class RecoveryOut(BaseModel):
    status: Literal["none", "waiting", "ready"]
    ready_at: datetime | None = None
    # The partner who can approve now (their display name), when they may.
    partner_name: str | None = None
    partner_asked: bool = False


class PartnerCodeOut(BaseModel):
    code: str  # six digits, read aloud to the partner
    partner_name: str


class AskedOut(BaseModel):
    id: str
    name: str
    device_label: str
    asked_at: datetime


class ApproveIn(BaseModel):
    code: str = Field(min_length=6, max_length=12)


class PartnerSettingOut(BaseModel):
    on: bool
    # Whether a partner could approve now: a household of two on its one live plan.
    possible: bool
    partner_name: str | None = None


class PartnerSettingIn(BaseModel):
    on: bool


def _name(user: User) -> str:
    return (user.display_name or "").strip() or "Your partner"


def _push(db: DbSession, user_id, body: str, tag: str, url: str = "/me/security") -> None:
    """Fixed words to the account's devices; an alert that can't be pushed is still emailed."""
    from app.jobs import alert_dispatch  # noqa: PLC0415 - keeps the router's imports light

    try:
        alert_dispatch._deliver(
            db,
            user_id,
            {"title": "Qash", "body": body, "tag": tag, "url": url},
            datetime.now(UTC),
        )
    except Exception as exc:  # noqa: BLE001 - the email already went
        log.exception("recovery push failed")
        ops_alerts.report("push_failed", "recovery._push", exc)


def _out(db: DbSession, caller: Caller) -> RecoveryOut:
    row = recovery_svc.open_request(db, caller.user.id)
    partner = recovery_svc.partner_for(db, caller.user)
    name = _name(partner) if partner is not None else None
    if row is None:
        return RecoveryOut(status="none", partner_name=name)
    ready = recovery_svc.may_add_passkey(db, caller.user.id, caller.session)
    return RecoveryOut(
        status="ready" if ready else "waiting",
        ready_at=row.ready_at,
        partner_name=name,
        partner_asked=row.partner_code_hash is not None or row.partner_approved_at is not None,
    )


def _needs_recovery(caller: Caller) -> None:
    """Only a session that can't unlock: the account has passkeys and this one hasn't used
    one. Someone with a working passkey has nothing to recover."""
    if not caller.principal.has_passkeys or not caller.principal.locked:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="not_needed")
    if caller.session.passkey_verified_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="not_needed")


@router.get("/api/auth/recovery")
def recovery_status(
    caller: Annotated[Caller, Depends(require_session)], db: Annotated[DbSession, Depends(get_db)]
) -> RecoveryOut:
    out = _out(db, caller)
    db.commit()  # an expired request is closed as it is read
    return out


@router.post(
    "/api/auth/recovery",
    dependencies=[Depends(rate_limited("recovery_start", key=session_or_ip))],
)
def recovery_start(
    request: Request,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> RecoveryOut:
    _needs_recovery(caller)
    row, made = recovery_svc.start(db, caller.user, caller.session)
    if made:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.RECOVERY_STARTED,
            target=f"recovery:{row.id}",
            ip=client_ip(request),
        )
    db.commit()
    if made:
        send_alert(
            caller.user.email,
            SecurityEvent.RECOVERY_STARTED,
            device_label=row.device_label,
            at=row.created_at,
        )
        _push(db, caller.user.id, RECOVERY_STARTED_LABEL, "recovery")
        db.commit()
    return _out(db, caller)


@router.post(
    "/api/auth/recovery/partner",
    dependencies=[Depends(rate_limited("recovery_partner", key=session_or_ip))],
)
def recovery_ask_partner(
    request: Request,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PartnerCodeOut:
    _needs_recovery(caller)
    row, made = recovery_svc.start(db, caller.user, caller.session)
    partner, code = recovery_svc.ask_partner(db, caller.user, row, caller.session)
    ip = client_ip(request)
    if made:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.RECOVERY_STARTED,
            target=f"recovery:{row.id}",
            ip=ip,
        )
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.RECOVERY_PARTNER_ASKED,
        target=f"recovery:{row.id}",
        ip=ip,
    )
    db.commit()
    if made:
        send_alert(
            caller.user.email,
            SecurityEvent.RECOVERY_STARTED,
            device_label=row.device_label,
            at=row.created_at,
        )
        _push(db, caller.user.id, RECOVERY_STARTED_LABEL, "recovery")
    _push(db, partner.id, RECOVERY_PARTNER_LABEL, "recovery-partner", "/me/household")
    db.commit()
    return PartnerCodeOut(code=code, partner_name=_name(partner))


@router.post("/api/auth/recovery/cancel")
def recovery_cancel(
    request: Request,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> RecoveryOut:
    """From the asking device ("I found my passkey"), or from any device signed in and
    unlocked (the owner, "this wasn't me"). A locked session that didn't ask can't cancel, or
    whoever holds the email could stop the owner's own recovery."""
    row = recovery_svc.open_request(db, caller.user.id, lock=True)
    if row is None:
        db.commit()
        return _out(db, caller)
    if caller.principal.locked and row.session_id != caller.session.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")
    recovery_svc.cancel(db, caller.user.id, "owner")
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.RECOVERY_CANCELLED,
        target=f"recovery:{row.id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.RECOVERY_CANCELLED,
        device_label=caller.session.device_label,
        at=datetime.now(UTC),
    )
    return _out(db, caller)


@router.get("/api/household/recovery")
def asked_of_me(
    caller: Annotated[Caller, Depends(require_unlocked)], db: Annotated[DbSession, Depends(get_db)]
) -> list[AskedOut]:
    out = []
    for row in recovery_svc.asked_of(db, caller.user):
        person = db.get(User, row.user_id)
        if person is None or recovery_svc.partner_for(db, person) is None:
            continue
        out.append(
            AskedOut(
                id=str(row.id),
                name=_name(person),
                device_label=row.device_label,
                asked_at=row.updated_at,
            )
        )
    return out


@router.post(
    "/api/household/recovery/approve",
    dependencies=[Depends(rate_limited("recovery_approve", key=session_or_ip))],
)
def approve(
    body: ApproveIn,
    request: Request,
    caller: Annotated[Caller, Depends(require_step_up)],
    db: Annotated[DbSession, Depends(get_db)],
) -> AskedOut:
    row = recovery_svc.approve(db, caller.user, body.code)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.RECOVERY_APPROVED,
        target=f"recovery:{row.id}",
        ip=client_ip(request),
    )
    db.commit()
    person = db.get(User, row.user_id)
    assert person is not None
    return AskedOut(
        id=str(row.id), name=_name(person), device_label=row.device_label, asked_at=row.updated_at
    )


def _setting(db: DbSession, user: User) -> PartnerSettingOut:
    was = user.recovery_partner_ok
    user.recovery_partner_ok = True  # ask "could a partner approve?" whatever the switch says
    partner = recovery_svc.partner_for(db, user)
    user.recovery_partner_ok = was
    return PartnerSettingOut(
        on=was and partner is not None,
        possible=partner is not None,
        partner_name=_name(partner) if partner is not None else None,
    )


@router.get("/api/account/recovery-partner")
def get_partner_setting(
    caller: Annotated[Caller, Depends(require_unlocked)], db: Annotated[DbSession, Depends(get_db)]
) -> PartnerSettingOut:
    return _setting(db, caller.user)


@router.put("/api/account/recovery-partner")
def put_partner_setting(
    body: PartnerSettingIn,
    request: Request,
    caller: Annotated[Caller, Depends(require_step_up)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PartnerSettingOut:
    recovery_svc.hold_if_recovered(caller.user)
    current = _setting(db, caller.user)
    if body.on and not current.possible:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="no_partner")
    caller.user.recovery_partner_ok = body.on
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.RECOVERY_PARTNER_SET,
        target=f"recovery_partner:{'on' if body.on else 'off'}",
        ip=client_ip(request),
    )
    db.commit()
    return _setting(db, caller.user)
