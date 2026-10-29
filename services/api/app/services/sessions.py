"""Per-device sessions carried by an HttpOnly cookie.

The cookie value is a random token; only its HMAC is stored, so the sessions table is
useless without STACKD_SECRET_KEY. A session is *locked* until the device passes a passkey
check, and again after `lock_after_seconds` without activity (docs/spec.md: 5-minute
auto-lock, reopening needs the passkey).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.session import Session
from app.models.user import User
from app.security.hashing import pseudonym, token_hash

COOKIE_NAME = "stackd_session"


def now_utc() -> datetime:
    return datetime.now(UTC)


def create_session(
    db: DbSession, user: User, *, device_label: str, ip: str | None, now: datetime | None = None
) -> tuple[Session, str]:
    """Start a session for this device. Returns (row, cookie token). Locked until a passkey
    check."""
    now = now or now_utc()
    token = secrets.token_urlsafe(32)
    row = Session(
        user_id=user.id,
        token_hash=token_hash(token),
        device_label=device_label[:80],
        ip_hash=pseudonym(ip) if ip else None,
        last_seen_at=now,
        expires_at=now + timedelta(days=get_settings().session_ttl_days),
    )
    db.add(row)
    db.flush()
    return row, token


def load_session(db: DbSession, token: str, *, now: datetime | None = None) -> Session | None:
    now = now or now_utc()
    row = db.scalars(select(Session).where(Session.token_hash == token_hash(token))).first()
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        return None
    return row


def is_locked(
    session: Session, *, lock_after_seconds: int | None = None, now: datetime | None = None
) -> bool:
    """No passkey check yet (and no phone's approval, `link_unlocked_at`), the app's screen
    locked it (`locked_at`), or idle for longer than the lock window: the user's own choice
    (users.lock_after_minutes, 5 to 60) when given, else the default setting. Idle counts only
    what the person does (see `touch`)."""
    now = now or now_utc()
    opened = max(
        (t for t in (session.passkey_verified_at, session.link_unlocked_at) if t is not None),
        default=None,
    )
    if opened is None or session.locked_at is not None:
        return True
    window = lock_after_seconds or get_settings().lock_after_seconds
    last_active = max(session.last_seen_at, opened)
    return now - last_active > timedelta(seconds=window)


def touch(session: Session, *, now: datetime | None = None) -> None:
    """Record activity: only for requests served while unlocked that the person made
    (principal.counts_as_activity; owner decision, October 28, 2026)."""
    now = now or now_utc()
    if now - session.last_seen_at > timedelta(seconds=30):
        session.last_seen_at = now


def mark_passkey_verified(session: Session, *, now: datetime | None = None) -> None:
    now = now or now_utc()
    session.passkey_verified_at = now
    session.last_seen_at = now
    session.locked_at = None


def mark_unlocked_by_link(session: Session, *, now: datetime | None = None) -> None:
    """Link with your phone (invariant 44, owner decision, October 29, 2026): the phone's
    approval opens this computer unlocked, but it is not a passkey check on the computer, so
    `passkey_verified_at` is left empty and every step-up route asks for one here first."""
    now = now or now_utc()
    session.link_unlocked_at = now
    session.last_seen_at = now
    session.locked_at = None


def lock(session: Session, *, now: datetime | None = None) -> None:
    """The app's screen locked: lock this session too, until the next passkey check."""
    if session.locked_at is None:
        session.locked_at = now or now_utc()


def revoke(session: Session, *, reason: str = "signed_out", now: datetime | None = None) -> None:
    """End a session: signed out here, signed out from another device, or account deleted."""
    session.revoked_at = now or now_utc()
    session.ended_reason = reason


def set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=s.session_ttl_days * 86400,
        path="/",
        secure=s.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def clear_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(
        COOKIE_NAME, path="/", secure=s.cookie_secure, httponly=True, samesite="lax"
    )
