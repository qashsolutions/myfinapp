"""Link with your phone (owner decisions, October 19, 2026; docs/spec.md "Signing in on another
device").

- POST /api/auth/link/start (no session): a computer asks; answers an 8-character code to show
  (and draw as a QR code) and sets an HttpOnly cookie holding a secret only it knows
- GET  /api/auth/link/status (no session, that cookie): pending, approved (once: the session
  cookie for the approving account is set right here), denied or expired
- POST /api/auth/link/lookup (signed in, unlocked): what the code asks for, and whether the
  computer is on the same network as the phone
- POST /api/auth/link/approve (signed in, fresh passkey check): approves; a different network
  needs `confirm_different_network` (owner: warn and ask)
- POST /api/auth/link/deny (signed in, unlocked)

Trade-off, recorded in the spec and the security plan: the browser's own phone sign-in proves
the phone is nearby over Bluetooth; this does not, so the approval screen names the device and
warns on a different network, requests last 2 minutes, and every link is audited and alerted.
"""

from __future__ import annotations

import ipaddress
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models.device_link import DeviceLink
from app.models.user import User
from app.routers.auth import SessionInfo, _session_info
from app.security.audit import AuditAction, record
from app.security.authz import Principal
from app.security.client import client_ip, device_label
from app.security.csrf import same_site_only
from app.security.hashing import pseudonym, token_hash
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited
from app.services import sessions as sessions_svc
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(prefix="/api/auth/link", tags=["auth"], dependencies=[Depends(same_site_only)])

LINK_TTL = timedelta(minutes=2)  # proposed (owner, October 19, 2026)
COOKIE = "stackd_link"
# No 0/O/1/I, like invite codes; 32 letters, so 8 of them carry 40 bits.
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_RE = r"^[A-Za-z2-9\- ]{8,11}$"


class StartOut(BaseModel):
    code: str  # "ABCD-EFGH"
    expires_in_seconds: int


class StatusOut(BaseModel):
    status: Literal["pending", "approved", "denied", "expired"]
    session: SessionInfo | None = None


class CodeIn(BaseModel):
    code: str = Field(pattern=CODE_RE)


class ApproveIn(CodeIn):
    confirm_different_network: bool = False


class LookupOut(BaseModel):
    device_label: str
    requested_at: datetime
    expires_in_seconds: int
    same_network: bool


def _now() -> datetime:
    return datetime.now(UTC)


def _normalize(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def network_of(ip: str) -> str | None:
    """A pseudonym of the caller's network: the /24 for IPv4, the /64 for IPv6. Phones and
    computers at one home share it; an unknown address shares nothing."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    prefix = 24 if addr.version == 4 else 64
    return pseudonym(str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False)))


def _pending(db: DbSession, code: str, *, lock: bool = False) -> DeviceLink:
    query = select(DeviceLink).where(
        DeviceLink.code_hash == token_hash(_normalize(code)),
        DeviceLink.status == "pending",
        DeviceLink.expires_at > _now(),
    )
    row = db.scalars(query.with_for_update() if lock else query).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    return row


def _set_cookie(response: Response, secret: str) -> None:
    s = get_settings()
    response.set_cookie(
        COOKIE,
        secret,
        max_age=int(LINK_TTL.total_seconds()),
        path="/api/auth/link",
        secure=s.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def _clear_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(
        COOKIE, path="/api/auth/link", secure=s.cookie_secure, httponly=True, samesite="strict"
    )


@router.post("/start", dependencies=[Depends(rate_limited("device_link_start"))])
def start(
    request: Request, response: Response, db: Annotated[DbSession, Depends(get_db)]
) -> StartOut:
    ip = client_ip(request)
    code = "".join(secrets.choice(ALPHABET) for _ in range(8))
    secret = secrets.token_urlsafe(32)
    db.add(
        DeviceLink(
            code_hash=token_hash(code),
            secret_hash=token_hash(secret),
            device_label=device_label(request.headers.get("user-agent"), standalone=False)[:80],
            network_hash=network_of(ip),
            ip_hash=pseudonym(ip),
            expires_at=_now() + LINK_TTL,
        )
    )
    db.commit()
    _set_cookie(response, secret)
    return StartOut(code=f"{code[:4]}-{code[4:]}", expires_in_seconds=int(LINK_TTL.total_seconds()))


@router.get("/status", dependencies=[Depends(rate_limited("device_link_status"))])
def link_status(
    request: Request, response: Response, db: Annotated[DbSession, Depends(get_db)]
) -> StatusOut:
    secret = request.cookies.get(COOKIE)
    if not secret:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    row = db.scalars(
        select(DeviceLink).where(DeviceLink.secret_hash == token_hash(secret)).with_for_update()
    ).first()
    if row is None or row.status == "consumed":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    if row.status == "denied":
        _clear_cookie(response)
        return StatusOut(status="denied")
    if row.status == "pending":
        if row.expires_at <= _now():
            _clear_cookie(response)
            return StatusOut(status="expired")
        return StatusOut(status="pending")
    # Approved: this browser picks up a session for the approving account, exactly once.
    user = db.get(User, row.approved_by) if row.approved_by else None
    if user is None or user.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    ip = client_ip(request)
    label = device_label(request.headers.get("user-agent"), standalone=False)
    session, token = sessions_svc.create_session(db, user, device_label=label, ip=ip)
    # The phone's fresh passkey check stands in for this one: the computer opens unlocked, and
    # its own passkey is offered next (owner: offered, not required).
    sessions_svc.mark_passkey_verified(session)
    row.status = "consumed"
    row.session_id = session.id
    record(db, actor_id=user.id, action=AuditAction.SIGN_IN, target=f"session:{session.id}", ip=ip)
    db.commit()
    send_alert(user.email, SecurityEvent.DEVICE_LINKED, device_label=label, at=session.created_at)
    _clear_cookie(response)
    sessions_svc.set_cookie(response, token)
    db.refresh(session)
    principal = Principal(
        user_id=user.id,
        session_id=session.id,
        passkey_verified_at=session.passkey_verified_at,
        has_passkeys=True,
        locked=False,
    )
    return StatusOut(
        status="approved",
        session=_session_info(Caller(principal=principal, user=user, session=session)),
    )


@router.post("/lookup", dependencies=[Depends(rate_limited("device_link_lookup"))])
def lookup(
    body: CodeIn,
    request: Request,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> LookupOut:
    row = _pending(db, body.code)
    mine = network_of(client_ip(request))
    return LookupOut(
        device_label=row.device_label,
        requested_at=row.created_at,
        expires_in_seconds=max(0, int((row.expires_at - _now()).total_seconds())),
        same_network=mine is not None and mine == row.network_hash,
    )


@router.post("/approve")
def approve(
    body: ApproveIn,
    request: Request,
    caller: Annotated[Caller, Depends(require_step_up)],
    db: Annotated[DbSession, Depends(get_db)],
) -> StatusOut:
    row = _pending(db, body.code, lock=True)
    ip = client_ip(request)
    mine = network_of(ip)
    if not (mine is not None and mine == row.network_hash) and not body.confirm_different_network:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="different_network")
    row.status = "approved"
    row.approved_by = caller.user.id
    row.approved_at = _now()
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.DEVICE_LINK_APPROVED,
        target=f"device_link:{row.id}",
        ip=ip,
    )
    db.commit()
    return StatusOut(status="approved")


@router.post("/deny")
def deny(
    body: CodeIn,
    request: Request,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> StatusOut:
    row = _pending(db, body.code, lock=True)
    row.status = "denied"
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.DEVICE_LINK_DENIED,
        target=f"device_link:{row.id}",
        ip=client_ip(request),
    )
    db.commit()
    return StatusOut(status="denied")
