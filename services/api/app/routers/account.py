"""The account itself (docs/spec.md "Settings spec", "Download all my data", "Delete account").

- the display name other group members see
- change email: a code goes to the new address, after a fresh passkey check
- export: the one authenticated request that adds server-held data (account, groups, plan)
  to the ZIP the device builds from its own data
- delete: soft delete now (sessions revoked, passkeys gone, email tombstoned), hard purge
  after the grace period (`stackd-api purge-deleted`); the device wipes its own copy

Nothing here is money data.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models.billing import PurchaseConsent
from app.models.user import User
from app.routers.billing import PlanEventOut, history
from app.routers.groups import GroupSummary, my_groups
from app.rules_server.entitlements import effective_plan
from app.security.audit import AuditAction, record
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import sessions as sessions_svc
from app.services import stripe_billing
from app.services.deletion import soft_delete
from app.services.email import get_sender, otp_message
from app.services.otp import (
    OtpError,
    email_change_purpose,
    normalize_email,
    request_code,
    verify_code,
)
from app.services.recovery import hold_if_recovered
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(prefix="/api/account", tags=["account"], dependencies=[Depends(same_site_only)])


class AccountOut(BaseModel):
    email: str
    display_name: str | None
    look: str


class AccountPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    # The look picked in Settings, on the web or in a native app (users.look).
    look: Literal["modern", "minimal", "retro", "pastel", "anime", "illustrative"] | None = None


class ExportProfile(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str | None
    look: str
    mode: str
    simple_layout: bool
    receipt_retention: str
    created_at: datetime


class PlanOut(BaseModel):
    name: str = "free"
    status: str | None = None
    interval: str | None = None
    renews_at: datetime | None = None
    ends_at: datetime | None = None


class ConsentOut(BaseModel):
    plan: str
    interval: str | None
    price_cents: int
    terms_version: str
    terms_text: str
    agreed_at: datetime
    kind: str = "purchase"  # purchase, change or cancel


class ExportOut(BaseModel):
    exported_at: datetime
    profile: ExportProfile
    groups: list[GroupSummary]
    plan: PlanOut
    purchase_consents: list[ConsentOut] = []
    plan_history: list[PlanEventOut] = []


class DeleteRequest(BaseModel):
    confirm: Literal["DELETE"]


class EmailChangeRequest(BaseModel):
    new_email: EmailStr


class EmailVerifyRequest(BaseModel):
    new_email: EmailStr
    code: str = Field(min_length=6, max_length=6)


class CodeSent(BaseModel):
    sent: bool
    resend_after_seconds: int
    expires_in_seconds: int


def _out(caller: Caller) -> AccountOut:
    return AccountOut(
        email=caller.user.email, display_name=caller.user.display_name, look=caller.user.look
    )


def _otp_error(exc: OtpError) -> HTTPException:
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
    if exc.code == "locked":
        return HTTPException(status.HTTP_423_LOCKED, detail="locked", headers=headers)
    if exc.code == "too_soon":
        return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too_soon", headers=headers)
    detail: dict = {"code": exc.code}
    if exc.attempts_left is not None:
        detail["attempts_left"] = exc.attempts_left
    return HTTPException(status.HTTP_400_BAD_REQUEST, detail=detail)


@router.get("")
def account(caller: Annotated[Caller, Depends(require_unlocked)]) -> AccountOut:
    return _out(caller)


@router.patch("")
def update_account(
    body: AccountPatch,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> AccountOut:
    if body.display_name is None and body.look is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="nothing_to_change")
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_name")
        caller.user.display_name = name
    if body.look is not None:
        caller.user.look = body.look
    db.commit()
    return _out(caller)


# A POST (October 28, 2026): it audits and emails, and a cross-site GET carries the cookie.
@router.post("/export", dependencies=[Depends(rate_limited("export", key=session_or_ip))])
def export_data(
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> ExportOut:
    """Server-held data for the ZIP the device builds. Needs a fresh passkey check."""
    hold_if_recovered(caller.user)  # a day after an email-only recovery (invariant 74)
    now = datetime.now(UTC)
    user = caller.user
    record(
        db,
        actor_id=user.id,
        action=AuditAction.EXPORT,
        target=f"user:{user.id}",
        ip=client_ip(request),
    )
    send_alert(
        user.email,
        SecurityEvent.EXPORT_REQUESTED,
        device_label=caller.session.device_label,
        at=now,
    )
    db.commit()
    return ExportOut(
        exported_at=now,
        profile=ExportProfile(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            look=user.look,
            mode=user.mode,
            simple_layout=user.simple_layout,
            receipt_retention=user.receipt_retention,
            created_at=user.created_at,
        ),
        groups=my_groups(db, caller),
        plan=_plan_out(db, caller),
        plan_history=history(caller, db),
        purchase_consents=[
            ConsentOut(
                plan=c.plan,
                interval=c.interval,
                price_cents=c.price_cents,
                terms_version=c.terms_version,
                terms_text=c.terms_text,
                agreed_at=c.agreed_at,
                kind=c.kind,
            )
            for c in db.scalars(
                select(PurchaseConsent)
                .where(PurchaseConsent.user_id == user.id)
                .order_by(PurchaseConsent.agreed_at)
            )
        ],
    )


def _plan_out(db: DbSession, caller: Caller) -> PlanOut:
    plan, sub = effective_plan(db, caller.user.id)
    if sub is None:
        return PlanOut(name=plan)
    return PlanOut(
        name=plan,
        status=sub.status,
        interval=sub.interval,
        renews_at=sub.renews_at,
        ends_at=sub.ends_at,
    )


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    body: DeleteRequest,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_db)],
) -> Response:
    """Soft delete now; the grace period and purge are `deletion.py`. The body must say DELETE."""
    assert body.confirm == "DELETE"
    now = datetime.now(UTC)
    user = caller.user
    send_alert(
        user.email,
        SecurityEvent.DELETION_REQUESTED,
        device_label=caller.session.device_label,
        at=now,
    )
    record(
        db,
        actor_id=user.id,
        action=AuditAction.DELETE_REQUESTED,
        target=f"user:{user.id}",
        ip=client_ip(request),
    )
    soft_delete(db, user, now=now)
    db.commit()
    sessions_svc.clear_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/email/send", dependencies=[Depends(rate_limited("otp_send"))])
def email_change_send(
    body: EmailChangeRequest,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> CodeSent:
    """A one-time code to the new address; the old one stays until it is verified."""
    hold_if_recovered(caller.user)  # a day after an email-only recovery (invariant 74)
    s = get_settings()
    new_email = normalize_email(str(body.new_email))
    if new_email == caller.user.email:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="same_email")
    if db.scalar(select(User.id).where(User.email == new_email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="email_taken")
    try:
        code, _ = request_code(
            db, new_email, ip=client_ip(request), purpose=email_change_purpose(caller.user.id)
        )
    except OtpError as exc:
        raise _otp_error(exc) from exc
    db.commit()
    get_sender().send(otp_message(new_email, code, s.otp_ttl_seconds // 60))
    return CodeSent(
        sent=True, resend_after_seconds=s.otp_resend_seconds, expires_in_seconds=s.otp_ttl_seconds
    )


@router.post("/email/verify", dependencies=[Depends(rate_limited("otp_verify"))])
def email_change_verify(
    body: EmailVerifyRequest,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> AccountOut:
    new_email = normalize_email(str(body.new_email))
    if db.scalar(select(User.id).where(User.email == new_email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="email_taken")
    try:
        verify_code(db, new_email, body.code, purpose=email_change_purpose(caller.user.id))
    except OtpError as exc:
        db.commit()  # the failed attempt counts
        raise _otp_error(exc) from exc
    now = datetime.now(UTC)
    old_email = caller.user.email
    caller.user.email = new_email
    # A blocked account stays blocked under its new inbox (October 27, 2026).
    stripe_billing.carry_block(db, caller.user, old_email)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.EMAIL_CHANGED,
        target=f"user:{caller.user.id}",
        ip=client_ip(request),
    )
    for to in (old_email, new_email):
        send_alert(
            to, SecurityEvent.EMAIL_CHANGED, device_label=caller.session.device_label, at=now
        )
    db.commit()
    return _out(caller)
