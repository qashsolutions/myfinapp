"""Public account deletion (docs/spec.md 1W "W.3", the Google Play rule): from the website,
without the app, by a code emailed to the account's address.

- POST /api/public/account/delete/send {email}: always 200; a code is emailed only when an
  account exists (no account enumeration)
- POST /api/public/account/delete/verify {email, code}: the same soft delete as in-app deletion

No session, no CSRF guard (the site is another origin; `security/cors.py` admits only it);
the OTP limits apply per IP and per address.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db, get_session_factory
from app.models.user import User
from app.security.audit import AuditAction, record
from app.security.client import client_ip
from app.security.rate_limit import LIMITS, hit, rate_limited
from app.services.deletion import soft_delete
from app.services.email import deletion_code_message, get_sender
from app.services.otp import (
    DELETE_ACCOUNT,
    OtpError,
    normalize_email,
    request_code,
    verify_code,
)
from app.services.security_alerts import SecurityEvent, alert_if_locked, send_alert

router = APIRouter(prefix="/api/public/account", tags=["public"])


class EmailIn(BaseModel):
    email: EmailStr


class VerifyIn(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")


class Sent(BaseModel):
    sent: bool
    expires_in_seconds: int


def _email_rate_limit(body: EmailIn, request: Request) -> None:
    email = normalize_email(str(body.email))
    with get_session_factory()() as session, session.begin():
        decision = hit(session, LIMITS["otp_send_email"], f"email:{email}")
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate_limited",
            headers={"Retry-After": str(decision.retry_after)},
        )


def _live_user(db: DbSession, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email, User.deleted_at.is_(None)))


@router.post(
    "/delete/send",
    dependencies=[Depends(rate_limited("otp_send")), Depends(_email_rate_limit)],
)
def delete_send(body: EmailIn, request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Sent:
    s = get_settings()
    email = normalize_email(str(body.email))
    user = _live_user(db, email)
    if user is not None:
        try:
            code, _ = request_code(db, email, ip=client_ip(request), purpose=DELETE_ACCOUNT)
        except OtpError:
            code = None  # too soon after the last one: the earlier code still works
        db.commit()
        if code is not None:
            # In the fragment, which browsers never send: not in server or CDN logs, history
            # entries are cleared by the page, and never in a Referer (October 24, 2026).
            fragment = urlencode({"email": email, "code": code}, quote_via=quote)
            link = f"{s.site_origin}/delete-account#{fragment}"
            get_sender().send(deletion_code_message(email, code, s.otp_ttl_seconds // 60, link))
    return Sent(sent=True, expires_in_seconds=s.otp_ttl_seconds)


@router.post(
    "/delete/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("otp_verify"))],
)
def delete_verify(
    body: VerifyIn, request: Request, db: Annotated[DbSession, Depends(get_db)]
) -> Response:
    email = normalize_email(str(body.email))
    user = _live_user(db, email)
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "wrong_code"})
    try:
        verify_code(db, email, body.code, purpose=DELETE_ACCOUNT)
    except OtpError as exc:
        db.commit()  # the attempt counts
        alert_if_locked(db, exc, email, device_label="the website")
        if exc.code == "locked":
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail="locked",
                headers={"Retry-After": str(exc.retry_after or 0)},
            ) from exc
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": exc.code, "attempts_left": exc.attempts_left},
        ) from exc
    now = datetime.now(UTC)
    send_alert(user.email, SecurityEvent.DELETION_REQUESTED, device_label="the website", at=now)
    record(
        db,
        actor_id=user.id,
        action=AuditAction.DELETE_REQUESTED,
        target=f"user:{user.id}",
        ip=client_ip(request),
    )
    soft_delete(db, user, now=now)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
