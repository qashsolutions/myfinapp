"""Who is calling: the session cookie turned into a Principal (app/security/authz.py).

require_session   any live session, even before the first passkey (sign-up in progress)
require_unlocked  a session that passed a passkey check and has been active within the lock
                  window; records activity, but only what the person did
                  (counts_as_activity; owner decision, October 28, 2026)
require_step_up   unlocked *and* a passkey check within STACKD_STEP_UP_MAX_AGE_SECONDS
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.session import Session
from app.models.user import User
from app.security.authz import Principal
from app.security.step_up import require_fresh_passkey
from app.services import sessions as sessions_svc


@dataclass(frozen=True)
class Caller:
    principal: Principal
    user: User
    session: Session


def _load(request: Request, db: DbSession) -> Caller | None:
    token = request.cookies.get(sessions_svc.COOKIE_NAME)
    if not token:
        return None
    found = sessions_svc.load_signed_in(db, token)
    if found is None:
        return None
    row, user, has_passkeys = found
    principal = Principal(
        user_id=user.id,
        session_id=row.id,
        passkey_verified_at=row.passkey_verified_at,
        has_passkeys=has_passkeys,
        locked=sessions_svc.is_locked(row, lock_after_seconds=user.lock_after_minutes * 60),
    )
    return Caller(principal=principal, user=user, session=row)


def optional_caller(request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Caller | None:
    return _load(request, db)


def require_session(request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Caller:
    caller = _load(request, db)
    if caller is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="sign_in_required")
    return caller


BACKGROUND_HEADER = "x-qash-background"


def counts_as_activity(request: Request) -> bool:
    """Whether this request is something the person did, so it may keep the session awake.

    Not: a call the app made on its own (`X-Qash-Background: 1`: syncs, timers, the alert
    schedule, refreshes), a request the browser marks as from anywhere but this site
    (`Sec-Fetch-Site` present and not `same-origin`, e.g. a link on another site, or an address
    typed in), or a page load (`Sec-Fetch-Mode: navigate`). Such requests are still served as
    usual; they just never push the auto-lock back. Clients that send neither header (tests,
    the native shell's own HTTP stack) count, as before.
    """
    if request.headers.get(BACKGROUND_HEADER) == "1":
        return False
    site = request.headers.get("sec-fetch-site")
    if site is not None and site != "same-origin":
        return False
    return request.headers.get("sec-fetch-mode") != "navigate"


def require_unlocked(
    request: Request,
    caller: Annotated[Caller, Depends(require_session)],
    db: Annotated[DbSession, Depends(get_db)],
) -> Caller:
    if caller.principal.locked:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="locked")
    if counts_as_activity(request):
        sessions_svc.touch(caller.session)
        db.commit()
    return caller


def require_step_up(caller: Annotated[Caller, Depends(require_unlocked)]) -> Caller:
    require_fresh_passkey(caller.principal)
    return caller
