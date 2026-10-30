"""Sign-in: email one-time code, then a session cookie. Passkeys live in routers/security.py.

docs/spec.md "Authentication": email + 6-digit code, valid 10 minutes, single use, max 5
attempts then a 15-minute lockout; rate-limited per email and per IP. The same code creates
the account ("New here? The same code creates your account."). No user enumeration: sending
answers the same way whether or not the address has an account.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db, get_session_factory
from app.models.session import Session
from app.models.user import User
from app.security.audit import AuditAction, record
from app.security.authz import Principal
from app.security.client import client_ip, device_label
from app.security.csrf import same_site_only
from app.security.hashing import pseudonym
from app.security.principal import Caller, optional_caller, require_session
from app.security.rate_limit import LIMITS, hit, rate_limited
from app.services import recovery as recovery_svc
from app.services import sessions as sessions_svc
from app.services import webauthn as webauthn_svc
from app.services.email import get_sender, otp_message
from app.services.otp import OtpError, normalize_email, request_code, verify_code
from app.services.security_alerts import SecurityEvent, alert_if_locked, send_alert
from app.services.webauthn import credentials_for

router = APIRouter(prefix="/api/auth", tags=["auth"], dependencies=[Depends(same_site_only)])


class OtpSendRequest(BaseModel):
    email: EmailStr


class OtpSendResponse(BaseModel):
    sent: bool
    resend_after_seconds: int
    expires_in_seconds: int


class OtpVerifyRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
    display_mode: Literal["browser", "standalone"] = "browser"


class PasskeyOptionsOut(BaseModel):
    options: dict


class PasskeySignInRequest(BaseModel):
    credential: dict
    display_mode: Literal["browser", "standalone"] = "browser"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str | None
    look: str  # chosen in the native apps (Phase 2); the PWA reads it and renders Modern


class SessionInfo(BaseModel):
    authenticated: bool
    user: UserOut | None = None
    session_id: uuid.UUID | None = None
    device_label: str | None = None
    has_passkeys: bool = False
    locked: bool = True
    passkey_verified_at: datetime | None = None
    lock_after_seconds: int
    step_up_max_age_seconds: int
    # This device's own (revoked) session belonged to an account that has been deleted, from
    # another device, the website or a plan that ended: the app erases what it kept here.
    deleted_user_id: uuid.UUID | None = None
    # Why: "requested" (erase this device) or "plan_ended" (keep it until the person decides).
    deleted_reason: Literal["requested", "plan_ended"] | None = None


def _otp_error(exc: OtpError) -> HTTPException:
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
    if exc.code == "locked":
        return HTTPException(status.HTTP_423_LOCKED, detail="locked", headers=headers)
    if exc.code == "too_soon":
        return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too_soon", headers=headers)
    detail: dict[str, object] = {"code": exc.code}
    if exc.attempts_left is not None:
        detail["attempts_left"] = exc.attempts_left
    return HTTPException(status.HTTP_400_BAD_REQUEST, detail=detail)


def _email_rate_limit(body: OtpSendRequest) -> None:
    email = normalize_email(body.email)
    with get_session_factory()() as db, db.begin():
        decision = hit(db, LIMITS["otp_send_email"], f"email:{email}")
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate_limited",
            headers={"Retry-After": str(decision.retry_after)},
        )


@router.post(
    "/otp/send",
    dependencies=[Depends(rate_limited("otp_send")), Depends(_email_rate_limit)],
)
def otp_send(
    body: OtpSendRequest, request: Request, db: Annotated[DbSession, Depends(get_db)]
) -> OtpSendResponse:
    s = get_settings()
    email = normalize_email(body.email)
    try:
        code, _ = request_code(db, email, ip=client_ip(request))
    except OtpError as exc:
        raise _otp_error(exc) from exc
    db.commit()
    get_sender().send(otp_message(email, code, s.otp_ttl_seconds // 60))
    return OtpSendResponse(
        sent=True, resend_after_seconds=s.otp_resend_seconds, expires_in_seconds=s.otp_ttl_seconds
    )


def _session_info(caller: Caller | None) -> SessionInfo:
    s = get_settings()
    if caller is None:
        return SessionInfo(
            authenticated=False,
            lock_after_seconds=s.lock_after_seconds,
            step_up_max_age_seconds=s.step_up_max_age_seconds,
        )
    p = caller.principal
    return SessionInfo(
        authenticated=True,
        user=UserOut(
            id=caller.user.id,
            email=caller.user.email,
            display_name=caller.user.display_name,
            look=caller.user.look,
        ),
        session_id=caller.session.id,
        device_label=caller.session.device_label,
        has_passkeys=p.has_passkeys,
        locked=p.locked,
        passkey_verified_at=p.passkey_verified_at,
        lock_after_seconds=caller.user.lock_after_minutes * 60,
        step_up_max_age_seconds=s.step_up_max_age_seconds,
    )


@router.post("/otp/verify", dependencies=[Depends(rate_limited("otp_verify"))])
def otp_verify(
    body: OtpVerifyRequest,
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> SessionInfo:
    email = normalize_email(body.email)
    ip = client_ip(request)
    try:
        verify_code(db, email, body.code)
    except OtpError as exc:
        if exc.code in {"wrong_code", "locked"}:
            record(
                db,
                actor_id=None,
                action=AuditAction.SIGN_IN_FAILED,
                target=f"email:{pseudonym(email)}",
                ip=ip,
            )
        db.commit()
        alert_if_locked(
            db, exc, email, device_label=device_label(request.headers.get("user-agent"))
        )
        raise _otp_error(exc) from exc

    user = db.scalars(select(User).where(User.email == email)).first()
    created = user is None
    if user is None:
        user = User(email=email)
        db.add(user)
        db.flush()
    label = device_label(
        request.headers.get("user-agent"), standalone=body.display_mode == "standalone"
    )
    session, token = sessions_svc.create_session(db, user, device_label=label, ip=ip)
    record(db, actor_id=user.id, action=AuditAction.SIGN_IN, target=f"session:{session.id}", ip=ip)
    db.commit()
    if not created:
        send_alert(user.email, SecurityEvent.NEW_SIGN_IN, device_label=label, at=session.created_at)
    sessions_svc.set_cookie(response, token)
    db.refresh(session)
    principal = Principal(
        user_id=user.id,
        session_id=session.id,
        passkey_verified_at=None,
        has_passkeys=bool(credentials_for(db, user.id)),
        locked=True,
    )
    return _session_info(Caller(principal=principal, user=user, session=session))


@router.post("/passkey/options", dependencies=[Depends(rate_limited("passkey_options"))])
def passkey_options(db: Annotated[DbSession, Depends(get_db)]) -> PasskeyOptionsOut:
    """Sign in with a passkey the device already has (October 13, 2026): no email, no code.
    The device shows its own picker of the passkeys it holds for this site."""
    options = webauthn_svc.signin_options(db)
    db.commit()
    return PasskeyOptionsOut(options=webauthn_svc.options_payload(options))


@router.post("/passkey/verify", dependencies=[Depends(rate_limited("sign_in"))])
def passkey_sign_in(
    body: PasskeySignInRequest,
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> SessionInfo:
    """A verified passkey (with Face ID, Touch ID, fingerprint or device passcode) signs in and
    unlocks in one step: it is the stronger of our two factors, and phishing-resistant. Same
    audit and new-sign-in alert as an email-code sign-in."""
    ip = client_ip(request)
    try:
        user, _cred = webauthn_svc.verify_signin(db, body.credential)
    except webauthn_svc.WebauthnError as exc:
        record(db, actor_id=None, action=AuditAction.SIGN_IN_FAILED, target="passkey", ip=ip)
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    label = device_label(
        request.headers.get("user-agent"), standalone=body.display_mode == "standalone"
    )
    session, token = sessions_svc.create_session(db, user, device_label=label, ip=ip)
    sessions_svc.mark_passkey_verified(session)
    record(db, actor_id=user.id, action=AuditAction.SIGN_IN, target=f"session:{session.id}", ip=ip)
    # The owner signed in with a passkey: a recovery waiting on the account ends (invariant 74).
    cancelled = recovery_svc.cancel_on_passkey(db, user.id)
    if cancelled is not None:
        record(
            db,
            actor_id=user.id,
            action=AuditAction.RECOVERY_CANCELLED,
            target=f"recovery:{cancelled.id}",
            ip=ip,
        )
    db.commit()
    send_alert(user.email, SecurityEvent.NEW_SIGN_IN, device_label=label, at=session.created_at)
    if cancelled is not None:
        send_alert(
            user.email, SecurityEvent.RECOVERY_CANCELLED, device_label=label, at=session.created_at
        )
    sessions_svc.set_cookie(response, token)
    db.refresh(session)
    principal = Principal(
        user_id=user.id,
        session_id=session.id,
        passkey_verified_at=session.passkey_verified_at,
        has_passkeys=True,
        locked=False,
    )
    return _session_info(Caller(principal=principal, user=user, session=session))


@router.get("/session")
def session_info(
    caller: Annotated[Caller | None, Depends(optional_caller)],
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> SessionInfo:
    """The app's first call on start-up. Never an error: `authenticated` says it all."""
    info = _session_info(caller)
    if caller is None:
        token = request.cookies.get(sessions_svc.COOKIE_NAME)
        row = (
            db.scalars(
                select(Session).where(Session.token_hash == sessions_svc.token_hash(token))
            ).first()
            if token
            else None
        )
        if row is not None and row.ended_reason in ("account_deleted", "plan_ended"):
            info.deleted_user_id = row.user_id
            info.deleted_reason = "plan_ended" if row.ended_reason == "plan_ended" else "requested"
            sessions_svc.clear_cookie(response)  # said once; the device then starts fresh
    return info


@router.post("/lock", status_code=status.HTTP_204_NO_CONTENT)
def lock_session(
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """The app's screen locked (idle, or the person locked it): this session is locked on the
    server too until the next passkey check (owner decision, October 28, 2026). Works on a
    session that is already locked; not audited, like the idle lock it mirrors."""
    sessions_svc.lock(caller.session)
    db.commit()


@router.post("/signout")
def sign_out(
    caller: Annotated[Caller, Depends(require_session)],
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> SessionInfo:
    sessions_svc.revoke(caller.session, reason="signed_out")
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.SIGN_OUT,
        target=f"session:{caller.session.id}",
        ip=client_ip(request),
    )
    db.commit()
    sessions_svc.clear_cookie(response)
    return _session_info(None)
