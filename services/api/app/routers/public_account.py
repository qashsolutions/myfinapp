"""Public account deletion (docs/spec.md 1W "W.3", the Google Play rule): from the website,
without the app, by a code emailed to the account's address.

- POST /api/public/account/delete/send {email}: always 200; a code is emailed only when an
  account exists (no account enumeration)
- POST /api/public/account/delete/verify {email, code}: the same soft delete as in-app deletion

Neither route tells whether an account exists (October 28, 2026): a code row is written and
checked for every address, so wrong codes, attempts left and the lockout read the same; email
goes out after the answer, so the time a send takes says nothing either.

No session, no CSRF guard (the site is another origin; `security/cors.py` admits only it);
the OTP limits apply per IP and per address.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import quote, urlencode

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db, get_session_factory
from app.models.user import User
from app.security.audit import AuditAction, record
from app.security.client import client_ip
from app.security.rate_limit import LIMITS, hit, rate_limited
from app.services import ops_alerts
from app.services.deletion import soft_delete
from app.services.email import Message, deletion_code_message, get_sender
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


def _send_after(message: Message) -> None:
    """Runs after the answer went out; a mail failure reaches the admins, never the caller."""
    try:
        get_sender().send(message)
    except Exception as exc:  # noqa: BLE001 - reported, never raised past the response
        ops_alerts.report("email", "public_account.delete_send", exc)


@router.post(
    "/delete/send",
    dependencies=[Depends(rate_limited("otp_send")), Depends(_email_rate_limit)],
)
def delete_send(
    body: EmailIn,
    request: Request,
    background: BackgroundTasks,
    db: Annotated[DbSession, Depends(get_db)],
) -> Sent:
    s = get_settings()
    email = normalize_email(str(body.email))
    user = _live_user(db, email)
    # The same work for every address, so neither the answer nor its timing says whether an
    # account exists: the code row is written either way and only a live account's is mailed.
    try:
        code, _ = request_code(db, email, ip=client_ip(request), purpose=DELETE_ACCOUNT)
    except OtpError:
        code = None  # too soon after the last one, or locked: the earlier code still works
    db.commit()
    if code is not None and user is not None:
        # In the fragment, which browsers never send: not in server or CDN logs, history
        # entries are cleared by the page, and never in a Referer (October 24, 2026).
        fragment = urlencode({"email": email, "code": code}, quote_via=quote)
        link = f"{s.site_origin}/delete-account#{fragment}"
        message = deletion_code_message(email, code, s.otp_ttl_seconds // 60, link)
        background.add_task(_send_after, message)
    return Sent(sent=True, expires_in_seconds=s.otp_ttl_seconds)


@router.post(
    "/delete/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("otp_verify"))],
)
def delete_verify(
    body: VerifyIn,
    request: Request,
    background: BackgroundTasks,
    db: Annotated[DbSession, Depends(get_db)],
) -> Response:
    email = normalize_email(str(body.email))
    user = _live_user(db, email)
    # Every address's code is checked and counted the same way (no account oracle).
    try:
        verify_code(db, email, body.code, purpose=DELETE_ACCOUNT)
    except OtpError as exc:
        db.commit()  # the attempt counts
        # Returned, not raised: a raised error drops the background tasks, and the lockout
        # alert must go after the answer so its time says nothing.
        alert_if_locked(db, exc, email, device_label="the website", background=background)
        if exc.code == "locked":
            return JSONResponse(
                {"detail": "locked"},
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                headers={"Retry-After": str(exc.retry_after or 0)},
                background=background,
            )
        return JSONResponse(
            {"detail": {"code": exc.code, "attempts_left": exc.attempts_left}},
            status_code=status.HTTP_400_BAD_REQUEST,
            background=background,
        )
    if user is None:
        # Only reachable by guessing a code that was never mailed: answer as for an account.
        db.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
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
