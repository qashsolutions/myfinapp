"""Passkeys and signed-in devices (docs/spec.md "Account security (day 1)", "Sign-in & security").

- register: the mandatory passkey at sign-up, and "+ Add a passkey" later
- assert: unlock after the auto-lock, and the step-up check before sensitive actions
- list and remove passkeys; list and sign out devices (both need a fresh passkey check)
- set the auto-lock window, 5 to 60 minutes (a fresh passkey check; a longer lock is weaker)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession
from webauthn.helpers import base64url_to_bytes

from app.db import get_db
from app.models.audit_log import AuditLog
from app.models.session import Session
from app.models.user import LOCK_MAX_MINUTES, LOCK_MIN_MINUTES, User
from app.models.webauthn_credential import WebauthnCredential
from app.security.audit import AuditAction, record
from app.security.authz import get_owned, owned_by
from app.security.client import client_ip, device_label
from app.security.csrf import same_site_only
from app.security.hashing import pseudonym
from app.security.principal import Caller, require_session, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import recovery as recovery_svc
from app.services import sessions as sessions_svc
from app.services import webauthn as webauthn_svc
from app.services.account_lock import lock_account
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(
    prefix="/api/security", tags=["security"], dependencies=[Depends(same_site_only)]
)


class OptionsOut(BaseModel):
    options: dict


class RegisterVerifyRequest(BaseModel):
    credential: dict
    label: str | None = Field(default=None, max_length=80)


class AssertOptionsRequest(BaseModel):
    purpose: Literal["unlock", "step_up", "sign_in"] = "unlock"
    # base64url, 16-64 bytes: asks for the PRF extension (backup key, chunk 1.16)
    prf_salt: str | None = Field(default=None, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")


class AssertVerifyRequest(BaseModel):
    credential: dict


class PasskeyOut(BaseModel):
    id: uuid.UUID
    label: str
    created_at: datetime
    last_used_at: datetime | None


class AssertResult(BaseModel):
    passkey_verified_at: datetime
    locked: bool = False


class DeviceOut(BaseModel):
    id: uuid.UUID
    label: str
    created_at: datetime  # when this device signed in
    last_seen_at: datetime
    current: bool
    # current | active | signed_out | signed_out_remote | expired | account_deleted
    status: str = "active"
    ended_at: datetime | None = None


class ActivityOut(BaseModel):
    at: datetime
    # sign_in | sign_in_failed | sign_out | device_signed_out | passkey_added | passkey_removed
    # | email_changed | export | lock_changed
    kind: str
    device_label: str | None = None


def _passkey_out(row: WebauthnCredential) -> PasskeyOut:
    return PasskeyOut(
        id=row.id, label=row.device_label, created_at=row.created_at, last_used_at=row.last_used_at
    )


def _webauthn_error(exc: webauthn_svc.WebauthnError) -> HTTPException:
    if exc.code == "no_passkeys":
        return HTTPException(status.HTTP_409_CONFLICT, detail="no_passkeys")
    return HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code)


def _may_register(request: Request, caller: Caller, db: DbSession) -> bool:
    """The first passkey is part of sign-up (the email code is the proof). Any later one needs an
    unlocked session and a fresh passkey check, or a stolen cookie, even a locked one, could enrol
    its own passkey and come out unlocked and step-up fresh. -> True when it is allowed only
    because a recovery is ready for this session (invariant 74)."""
    if caller.principal.has_passkeys:
        if recovery_svc.may_add_passkey(db, caller.user.id, caller.session):
            return True
        try:
            require_step_up(require_unlocked(request, caller, db))
        except HTTPException:
            # The owner cancelled this session's request before its passkey got here: the same
            # answer as a cancel that lands mid-way (invariant 74), so the screen says so.
            if recovery_svc.closed_for(db, caller.user.id, caller.session):
                raise HTTPException(status.HTTP_409_CONFLICT, detail="recovery_closed") from None
            raise
    return False


@router.post("/passkeys/register/options")
def register_options(
    request: Request,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> OptionsOut:
    _may_register(request, caller, db)
    options = webauthn_svc.registration_options(db, caller.user, session_id=caller.session.id)
    db.commit()
    return OptionsOut(options=webauthn_svc.options_payload(options))


@router.post(
    "/passkeys/register/verify",
    dependencies=[Depends(rate_limited("passkey_add", key=session_or_ip))],
)
def register_verify(
    body: RegisterVerifyRequest,
    caller: Annotated[Caller, Depends(require_session)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> PasskeyOut:
    recovering = _may_register(request, caller, db)
    ip = client_ip(request)
    label = body.label or _default_passkey_label(request.headers.get("user-agent"))
    try:
        row = webauthn_svc.verify_registration(
            db, caller.user, body.credential, session_id=caller.session.id, device_label=label
        )
    except webauthn_svc.WebauthnError as exc:
        db.commit()
        raise _webauthn_error(exc) from exc
    # A recovery ready for this session ends here: the old passkeys go, other devices are
    # signed out (invariant 74).
    recovered = recovery_svc.finish(db, caller.user, caller.session, row.id) if recovering else None
    if recovering and recovered is None:
        # The request closed while the passkey was being made (the owner used theirs): the new
        # passkey is undone, never kept beside the owner's.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="recovery_closed")
    sessions_svc.mark_passkey_verified(caller.session)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PASSKEY_ADDED,
        target=f"passkey:{row.id}",
        ip=ip,
    )
    if recovered is not None:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.RECOVERY_DONE,
            target=f"recovery:{recovered.id}",
            ip=ip,
        )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.RECOVERY_DONE if recovered is not None else SecurityEvent.PASSKEY_ADDED,
        device_label=caller.session.device_label,
        at=row.created_at,
    )
    return _passkey_out(row)


def _default_passkey_label(user_agent: str | None) -> str:
    device = device_label(user_agent).split(" on ", 1)[-1]
    return f"{device} passkey"


@router.post("/passkeys/assert/options")
def assert_options(
    body: AssertOptionsRequest,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> OptionsOut:
    prf_salt = None
    if body.prf_salt is not None:
        prf_salt = base64url_to_bytes(body.prf_salt)
        if not 16 <= len(prf_salt) <= 64:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="bad_prf_salt")
    try:
        options = webauthn_svc.authentication_options(
            db, caller.user, session_id=caller.session.id, prf_salt=prf_salt
        )
    except webauthn_svc.WebauthnError as exc:
        raise _webauthn_error(exc) from exc
    db.commit()
    return OptionsOut(options=webauthn_svc.options_payload(options))


@router.post("/passkeys/assert/verify")
def assert_verify(
    body: AssertVerifyRequest,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> AssertResult:
    lock_account(db, caller.user.id)  # before any write: the recovery lock order (invariant 74)
    try:
        webauthn_svc.verify_authentication(
            db, caller.user, body.credential, session_id=caller.session.id
        )
    except webauthn_svc.WebauthnError as exc:
        db.commit()
        raise _webauthn_error(exc) from exc
    sessions_svc.mark_passkey_verified(caller.session)
    cancelled = recovery_svc.cancel_on_passkey(db, caller.user.id)
    if cancelled is not None:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.RECOVERY_CANCELLED,
            target=f"recovery:{cancelled.id}",
        )
    db.commit()
    if cancelled is not None:
        send_alert(
            caller.user.email,
            SecurityEvent.RECOVERY_CANCELLED,
            device_label=caller.session.device_label,
            at=datetime.now(UTC),
        )
    assert caller.session.passkey_verified_at is not None
    return AssertResult(passkey_verified_at=caller.session.passkey_verified_at, locked=False)


@router.get("/passkeys")
def list_passkeys(
    caller: Annotated[Caller, Depends(require_unlocked)], db: Annotated[DbSession, Depends(get_db)]
) -> list[PasskeyOut]:
    rows = db.scalars(
        owned_by(select(WebauthnCredential), WebauthnCredential, caller.principal).order_by(
            WebauthnCredential.created_at
        )
    )
    return [_passkey_out(r) for r in rows]


@router.delete(
    "/passkeys/{passkey_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("passkey_remove", key=session_or_ip))],
)
def remove_passkey(
    passkey_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    # The person's row first, so two removals at once look and count one after the other and
    # the last passkey always stays (October 28, 2026).
    db.execute(select(User.id).where(User.id == caller.user.id).with_for_update())
    row = get_owned(db, WebauthnCredential, passkey_id, caller.principal)
    if len(webauthn_svc.credentials_for(db, caller.user.id)) <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="last_passkey")
    db.delete(row)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PASSKEY_REMOVED,
        target=f"passkey:{passkey_id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.PASSKEY_REMOVED,
        device_label=caller.session.device_label,
        at=sessions_svc.now_utc(),
    )


HISTORY_DAYS = 30  # how far back Sign-in & security shows ended sessions and activity


def _status(row: Session, current_id: uuid.UUID, now: datetime) -> tuple[str, datetime | None]:
    if row.revoked_at is not None:
        return row.ended_reason or "signed_out", row.revoked_at
    if row.expires_at <= now:
        return "expired", row.expires_at
    return ("current" if row.id == current_id else "active"), None


@router.get("/devices")
def list_devices(
    caller: Annotated[Caller, Depends(require_unlocked)], db: Annotated[DbSession, Depends(get_db)]
) -> list[DeviceOut]:
    """Every device signed in now, then those whose session ended in the last 30 days, with
    when and how it ended. No IP addresses: only keyed hashes are stored."""
    now = sessions_svc.now_utc()
    since = now - timedelta(days=HISTORY_DAYS)
    rows = db.scalars(
        owned_by(select(Session), Session, caller.principal).where(
            (Session.revoked_at.is_(None) & (Session.expires_at > since))
            | (Session.revoked_at > since)
        )
    ).all()
    out = []
    for r in rows:
        state, ended = _status(r, caller.session.id, now)
        out.append(
            DeviceOut(
                id=r.id,
                label=r.device_label,
                created_at=r.created_at,
                last_seen_at=r.last_seen_at,
                current=r.id == caller.session.id,
                status=state,
                ended_at=ended,
            )
        )
    live = {"current": 0, "active": 1}
    out.sort(key=lambda d: (live.get(d.status, 2), -(d.ended_at or d.last_seen_at).timestamp()))
    return out


# Audit actions a user sees about their own account, and the kind name the app shows.
ACTIVITY = {
    AuditAction.SIGN_IN: "sign_in",
    AuditAction.SIGN_OUT: "sign_out",
    AuditAction.DEVICE_REVOKED: "device_signed_out",
    AuditAction.PASSKEY_ADDED: "passkey_added",
    AuditAction.PASSKEY_REMOVED: "passkey_removed",
    AuditAction.EMAIL_CHANGED: "email_changed",
    AuditAction.EXPORT: "export",
    AuditAction.LOCK_CHANGED: "lock_changed",
    AuditAction.DEVICE_LINK_APPROVED: "device_linked",
}


@router.get("/activity")
def activity(
    caller: Annotated[Caller, Depends(require_unlocked)], db: Annotated[DbSession, Depends(get_db)]
) -> list[ActivityOut]:
    """The last 30 days of sign-ins, failed sign-in attempts and security changes on this
    account, newest first (at most 100), so a user can spot anything that was not them."""
    since = sessions_svc.now_utc() - timedelta(days=HISTORY_DAYS)
    failed_target = f"email:{pseudonym(caller.user.email)}"
    rows = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.at > since,
            (
                (AuditLog.actor_id == caller.user.id)
                & AuditLog.action.in_([str(a) for a in ACTIVITY])
            )
            | (
                AuditLog.actor_id.is_(None)
                & (AuditLog.action == str(AuditAction.SIGN_IN_FAILED))
                & (AuditLog.target == failed_target)
            ),
        )
        .order_by(AuditLog.at.desc())
        .limit(100)
    ).all()
    session_ids = {
        uuid.UUID(r.target.split(":", 1)[1])
        for r in rows
        if r.target and r.target.startswith("session:")
    }
    labels = (
        {
            s.id: s.device_label
            for s in db.scalars(
                owned_by(select(Session), Session, caller.principal).where(
                    Session.id.in_(session_ids)
                )
            )
        }
        if session_ids
        else {}
    )
    out = []
    for r in rows:
        label = None
        if r.target and r.target.startswith("session:"):
            label = labels.get(uuid.UUID(r.target.split(":", 1)[1]))
        kind = (
            "sign_in_failed"
            if r.action == str(AuditAction.SIGN_IN_FAILED)
            else ACTIVITY[AuditAction(r.action)]
        )
        out.append(ActivityOut(at=r.at, kind=kind, device_label=label))
    return out


@router.delete(
    "/devices/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("device_sign_out", key=session_or_ip))],
)
def sign_out_device(
    session_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    row = get_owned(db, Session, session_id, caller.principal)
    if row.revoked_at is not None:
        return
    label = row.device_label
    sessions_svc.revoke(
        row, reason="signed_out" if row.id == caller.session.id else "signed_out_remote"
    )
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.DEVICE_REVOKED,
        target=f"session:{session_id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.DEVICE_SIGNED_OUT,
        device_label=label,
        at=sessions_svc.now_utc(),
    )
    if row.id == caller.session.id:
        sessions_svc.clear_cookie(response)


class LockIn(BaseModel):
    minutes: int = Field(ge=LOCK_MIN_MINUTES, le=LOCK_MAX_MINUTES)


class LockOut(BaseModel):
    minutes: int


@router.put("/lock")
def set_lock(
    body: LockIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> LockOut:
    """Auto-lock after this many idle minutes, on every device (owner decision, October 12,
    2026). The server enforces it too: an idle session past it is locked for every request."""
    if caller.user.lock_after_minutes != body.minutes:
        caller.user.lock_after_minutes = body.minutes
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.LOCK_CHANGED,
            target=f"user:{caller.user.id}",
            ip=client_ip(request),
        )
        db.commit()
    return LockOut(minutes=caller.user.lock_after_minutes)
