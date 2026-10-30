"""Getting back in without a passkey (owner decision, October 30, 2026; docs/spec.md "Getting
back in"; invariant 74). The one place these rules live; the routes only call them.

The order someone gets back in, quickest first: a synced passkey, another device still signed
in (Link with your phone), their household partner on the same household plan, then an email
code and 24 hours. This module is the last two.

- `start`: from a session signed in with an email code, still locked because the account has
  passkeys it can't use. One request at a time; asking again returns the one waiting.
- Ready when 24 hours have passed (`WAIT`), or at once when the partner types the code the
  person reads to them (`approve`). The partner must be in a household of two with them on its
  one plan, live for both, and the person must have turned on "Let my partner help"
  (`users.recovery_partner_ok`) while they still had a passkey.
- Every passkey check on the account while it waits cancels it (`cancel_on_passkey`): only the
  owner holds a passkey, so a request someone else started never finishes while they use the
  app. Cancel on any signed-in device does the same. Each step emails the account (always-on
  alerts) and pushes fixed words to its devices.
- Once ready, the account may add a new passkey (`may_add_passkey`): any of its sessions when
  the 24 hours made it ready, only the asking session when the partner did. The first passkey
  added `finish`es it: every old passkey is removed and every other session ended.
- After an email-only recovery, the most sensitive actions wait a day (`hold_if_recovered`):
  export, email change, linking a bank, replacing or turning off the backup.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from app.models.recovery import AccountRecovery
from app.models.session import Session
from app.models.user import User
from app.models.webauthn_credential import WebauthnCredential
from app.rules_server.entitlements import LIVE_STATES, household_plan
from app.security.hashing import token_hash
from app.services import sessions as sessions_svc

WAIT = timedelta(hours=24)  # owner decision, October 30, 2026
FINISH_WINDOW = timedelta(days=7)  # to add the new passkey once ready
HOLD = timedelta(hours=24)  # sensitive actions after an email-only recovery
CODE_DIGITS = 6

Reason = Literal["passkey", "owner", "expired"]


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(when: datetime) -> datetime:
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def open_request(
    db: DbSession, user_id: uuid.UUID, *, lock: bool = False
) -> AccountRecovery | None:
    """The request waiting for this account, if any (one at a time). One past its window is
    closed as expired here, so nothing reads it as open."""
    query = (
        select(AccountRecovery)
        .where(AccountRecovery.user_id == user_id, AccountRecovery.status == "waiting")
        .order_by(AccountRecovery.created_at.desc())
    )
    row = db.scalars(query.with_for_update() if lock else query).first()
    if row is not None and _aware(row.expires_at) <= _now():
        _close(row, "cancelled", "expired")
        db.flush()
        return None
    return row


def is_ready(row: AccountRecovery, *, now: datetime | None = None) -> bool:
    now = now or _now()
    return row.partner_approved_at is not None or _aware(row.ready_at) <= now


def partner_for(db: DbSession, user: User, *, now: datetime | None = None) -> User | None:
    """The partner who may approve: the other person in a household of two whose one plan is
    live for both of them ("two under one", owner decision, October 30, 2026). Not opted in,
    no household, a partner on a plan of their own, or a plan that has ended: None."""
    now = now or _now()
    if not user.recovery_partner_ok:
        return None
    mine = household_plan(db, user, now=now)
    if mine.pair is None or mine.state not in LIVE_STATES or "shared" not in mine.access:
        return None
    other_id = mine.pair[1] if mine.pair[0] == user.id else mine.pair[0]
    other = db.get(User, other_id)
    if other is None or other.deleted_at is not None:
        return None
    theirs = household_plan(db, other, now=now)
    if theirs.pair != mine.pair or theirs.state not in LIVE_STATES or "shared" not in theirs.access:
        return None
    return other


def start(db: DbSession, user: User, session: Session) -> tuple[AccountRecovery, bool]:
    """The waiting request for this account, made now if there is none. -> (row, made)."""
    row = open_request(db, user.id, lock=True)
    if row is not None:
        return row, False
    now = _now()
    row = AccountRecovery(
        user_id=user.id,
        session_id=session.id,
        device_label=session.device_label[:80],
        ready_at=now + WAIT,
        expires_at=now + WAIT + FINISH_WINDOW,
    )
    db.add(row)
    db.flush()
    return row, True


def ask_partner(
    db: DbSession, user: User, row: AccountRecovery, session: Session
) -> tuple[User, str]:
    """A fresh code for the partner to type, bound to the session that asked. -> (partner,
    code). 409 `no_partner` when nobody may approve."""
    partner = partner_for(db, user)
    if partner is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="no_partner")
    code = f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"
    row.partner_id = partner.id
    row.partner_code_hash = token_hash(f"recovery:{row.id}:{code}")
    row.session_id = session.id  # the partner approves the device the person is holding
    db.flush()
    return partner, code


def asked_of(db: DbSession, partner: User) -> list[AccountRecovery]:
    """Requests this person's partner asked them to approve, still waiting."""
    rows = db.scalars(
        select(AccountRecovery).where(
            AccountRecovery.partner_id == partner.id,
            AccountRecovery.status == "waiting",
            AccountRecovery.partner_code_hash.is_not(None),
            AccountRecovery.partner_approved_at.is_(None),
        )
    ).all()
    now = _now()
    return [r for r in rows if _aware(r.expires_at) > now]


def approve(db: DbSession, partner: User, code: str) -> AccountRecovery:
    """The partner typed the code: ready now, if they still may approve (same household, same
    live plan, still opted in). A wrong code is 400 `wrong_code`; nothing asked of them, 404."""
    code = "".join(ch for ch in code if ch.isdigit())
    for row in asked_of(db, partner):
        if row.partner_code_hash and secrets.compare_digest(
            row.partner_code_hash, token_hash(f"recovery:{row.id}:{code}")
        ):
            person = db.get(User, row.user_id)
            eligible = partner_for(db, person) if person is not None else None
            if eligible is None or eligible.id != partner.id:
                raise HTTPException(status.HTTP_409_CONFLICT, detail="no_partner")
            row.partner_approved_at = _now()
            row.partner_code_hash = None  # used once
            db.flush()
            return row
    if not asked_of(db, partner):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="wrong_code")


def _close(row: AccountRecovery, state: str, reason: str | None) -> None:
    row.status = state
    row.closed_at = _now()
    row.closed_reason = reason


def cancel(db: DbSession, user_id: uuid.UUID, reason: Reason) -> AccountRecovery | None:
    """Close the waiting request, if any. -> the row closed."""
    row = open_request(db, user_id, lock=True)
    if row is None:
        return None
    _close(row, "cancelled", reason)
    db.flush()
    return row


def cancel_on_passkey(db: DbSession, user_id: uuid.UUID) -> AccountRecovery | None:
    """A passkey check on the account: its owner is here, so any request waiting ends."""
    return cancel(db, user_id, "passkey")


def may_add_passkey(db: DbSession, user_id: uuid.UUID, session: Session) -> bool:
    """Whether this session may add a passkey without a passkey check, because a recovery is
    ready for it. Only a session that never used a passkey: someone signed in with one is the
    owner, and adding a passkey there is the ordinary kind, never a recovery."""
    if session.passkey_verified_at is not None:
        return False
    row = open_request(db, user_id)
    if row is None or not is_ready(row):
        return False
    if row.partner_approved_at is not None and _aware(row.ready_at) > _now():
        return row.session_id == session.id  # the partner approved that device only
    return True


def finish(
    db: DbSession, user: User, session: Session, new_credential_id: uuid.UUID
) -> AccountRecovery | None:
    """The new passkey is in: remove every other passkey, end every other session, close the
    request. An email-only recovery starts the day's hold. -> the row, or None if none was
    ready for this session."""
    if not may_add_passkey(db, user.id, session):
        return None
    row = open_request(db, user.id, lock=True)
    assert row is not None
    now = _now()
    db.execute(
        delete(WebauthnCredential).where(
            WebauthnCredential.user_id == user.id, WebauthnCredential.id != new_credential_id
        )
    )
    for other in db.scalars(
        select(Session).where(
            Session.user_id == user.id, Session.id != session.id, Session.revoked_at.is_(None)
        )
    ):
        sessions_svc.revoke(other, reason="recovered", now=now)
    if row.partner_approved_at is None:
        user.recovered_at = now
    _close(row, "done", None)
    db.flush()
    return row


def hold_if_recovered(user: User) -> None:
    """403 `recently_recovered` for a day after an email-only recovery."""
    if user.recovered_at is not None and _now() - _aware(user.recovered_at) < HOLD:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="recently_recovered")
