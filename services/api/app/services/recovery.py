"""Getting back in without a passkey (owner decision, October 30, 2026; docs/spec.md "Getting
back in"; invariant 74). The one place these rules live; the routes only call them.

The order someone gets back in, quickest first: a synced passkey, another device still signed
in (Link with your phone), their household partner on the same household plan, then an email
code and 24 hours. This module is the last two.

- `start`: from a session signed in with an email code, still locked because the account has
  passkeys it can't use. One waiting request per account (a unique index, and every step takes
  the account's lock first, `_lock_account`); asking again returns the one waiting.
- Ready when 24 hours have passed (`WAIT`), or at once when the partner types the code the
  person reads to them (`approve`), and then for the session that read it out only
  (`approved_session_id`). The partner must be the one the person chose
  (`users.recovery_partner_id`, while they still had a passkey) and in a household of two
  with them on its one plan, live for both. Asking again (`ask_partner`) makes a new code and
  clears any approval, so an approval can never move to another session.
- Every passkey check on the account while it waits cancels it (`cancel_on_passkey`): only the
  owner holds a passkey. Cancel on a signed-in device does the same. Each step emails the
  account (always-on alerts) and the start pushes fixed words to its devices.
- Once ready, the account may add a new passkey (`may_add_passkey`), only from a session that
  never used a passkey and was not opened by Link with your phone. The first passkey added
  `finish`es it under the account's lock: every old passkey is removed and every other session
  ended. If the request closed meanwhile, `finish` answers None and the caller must undo the
  new passkey.
- Unless the session the partner approved finishes it, the most sensitive actions wait a day
  (`hold_if_recovered`): export, email change, linking a bank, replacing or turning off the
  backup, changing who may approve.
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
from app.services.account_lock import lock_account

WAIT = timedelta(hours=24)  # owner decision, October 30, 2026
FINISH_WINDOW = timedelta(days=7)  # to add the new passkey once ready
HOLD = timedelta(hours=24)  # sensitive actions after an email-only recovery
CODE_DIGITS = 6
CODE_TRIES = 5  # wrong codes before a code stops working; the person then asks again

Reason = Literal["passkey", "owner", "expired"]


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(when: datetime) -> datetime:
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def _waiting(db: DbSession, user_id: uuid.UUID) -> list[AccountRecovery]:
    return list(
        db.scalars(
            select(AccountRecovery)
            .where(AccountRecovery.user_id == user_id, AccountRecovery.status == "waiting")
            .order_by(AccountRecovery.created_at.desc())
            .execution_options(populate_existing=True)
        )
    )


def open_request(db: DbSession, user_id: uuid.UUID) -> AccountRecovery | None:
    """The request waiting for this account, if any. One past its window is closed as expired
    here, so nothing reads it as open."""
    for row in _waiting(db, user_id):
        if _aware(row.expires_at) <= _now():
            _close(row, "cancelled", "expired")
            db.flush()
            continue
        return row
    return None


def is_ready(row: AccountRecovery, *, now: datetime | None = None) -> bool:
    now = now or _now()
    return row.partner_approved_at is not None or _aware(row.ready_at) <= now


def household_partner(db: DbSession, user: User, *, now: datetime | None = None) -> User | None:
    """The other person in a household of two whose one plan is live for both of them ("two
    under one", owner decision, October 30, 2026); None for no household, a partner on a plan
    of their own, or a plan that has ended."""
    now = now or _now()
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


def partner_for(db: DbSession, user: User, *, now: datetime | None = None) -> User | None:
    """The partner who may approve: the household partner on the shared plan, and the very
    person this account chose. A later household's partner needs choosing again."""
    if user.recovery_partner_id is None:
        return None
    partner = household_partner(db, user, now=now)
    return partner if partner is not None and partner.id == user.recovery_partner_id else None


def start(db: DbSession, user: User, session: Session) -> tuple[AccountRecovery, bool]:
    """The waiting request for this account, made now if there is none. -> (row, made)."""
    lock_account(db, user.id)
    row = open_request(db, user.id)
    if row is not None:
        return row, False
    now = _now()
    row = AccountRecovery(
        user_id=user.id,
        session_id=session.id,
        started_session_id=session.id,
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
    """A fresh code for the partner to type, for the session asking now. Any earlier code and
    any approval are cleared, so the partner approves exactly the device whose code they hear.
    -> (partner, code). 409 `no_partner` when nobody may approve."""
    lock_account(db, user.id)
    partner = partner_for(db, user)
    if partner is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="no_partner")
    code = f"{secrets.randbelow(10**CODE_DIGITS):0{CODE_DIGITS}d}"
    row.partner_id = partner.id
    row.partner_code_hash = token_hash(f"recovery:{row.id}:{session.id}:{code}")
    row.session_id = session.id
    row.device_label = session.device_label[:80]  # the partner sees the device asking now
    row.partner_approved_at = None
    row.approved_session_id = None
    row.partner_attempts = 0
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
    """The partner typed the code: ready now for the session that asked, if they still may
    approve (same household, same live plan, still the one chosen). A wrong code is 400
    `wrong_code`; nothing asked of them, 404."""
    code = "".join(ch for ch in code if ch.isdigit())
    asked = asked_of(db, partner)
    for found in asked:
        lock_account(db, found.user_id)
        row = db.get(AccountRecovery, found.id, populate_existing=True)
        if row is None or row.status != "waiting" or row.partner_code_hash is None:
            continue
        if not secrets.compare_digest(
            row.partner_code_hash, token_hash(f"recovery:{row.id}:{row.session_id}:{code}")
        ):
            continue
        person = db.get(User, row.user_id)
        eligible = partner_for(db, person) if person is not None else None
        if eligible is None or eligible.id != partner.id:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="no_partner")
        row.partner_approved_at = _now()
        row.approved_session_id = row.session_id
        row.partner_code_hash = None  # used once
        db.flush()
        return row
    if not asked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    # A wrong code counts against every code waiting for this partner; at CODE_TRIES it stops
    # working (the caller commits the count before answering).
    left = 0
    for found in asked:
        row = db.get(AccountRecovery, found.id, populate_existing=True)
        if row is None or row.partner_code_hash is None:
            continue
        row.partner_attempts += 1
        if row.partner_attempts >= CODE_TRIES:
            row.partner_code_hash = None
        left = max(left, CODE_TRIES - row.partner_attempts)
    db.flush()
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST, detail={"code": "wrong_code", "attempts_left": left}
    )


def _close(row: AccountRecovery, state: str, reason: str | None) -> None:
    row.status = state
    row.closed_at = _now()
    row.closed_reason = reason


def cancel_from(db: DbSession, user_id: uuid.UUID, session: Session, *, locked: bool):
    """Cancel from a device: any device signed in and unlocked (the owner), or the locked
    device that started the request ("I found my passkey"). Another locked session, even one
    that asked the partner since, can't: whoever holds the email could stop the owner's own
    recovery. Decided under the lock. -> the row closed, or None if nothing was waiting."""
    lock_account(db, user_id)
    rows = _waiting(db, user_id)
    if not rows:
        return None
    if locked and all(r.started_session_id != session.id for r in rows):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")
    return cancel(db, user_id, "owner")


def cancel(db: DbSession, user_id: uuid.UUID, reason: Reason) -> AccountRecovery | None:
    """Close every waiting request for the account. -> one of the rows closed, if any."""
    lock_account(db, user_id)
    closed = None
    for row in _waiting(db, user_id):
        _close(row, "cancelled", reason)
        closed = closed or row
    db.flush()
    return closed


def cancel_on_passkey(db: DbSession, user_id: uuid.UUID) -> AccountRecovery | None:
    """A passkey check on the account: its owner is here, so any request waiting ends."""
    return cancel(db, user_id, "passkey")


def may_add_passkey(db: DbSession, user_id: uuid.UUID, session: Session) -> bool:
    """Whether this session may add a passkey without a passkey check, because a recovery is
    ready for it. Never a session that used a passkey or was opened by a phone's approval:
    that is the owner, and adding a passkey there is the ordinary kind, never a recovery."""
    if session.passkey_verified_at is not None or session.link_unlocked_at is not None:
        return False
    row = open_request(db, user_id)
    if row is None:
        return False
    if row.partner_approved_at is not None and row.approved_session_id == session.id:
        return True  # the device the partner let in
    return _aware(row.ready_at) <= _now()  # the 24 hours are up: any email-code session


def finish(
    db: DbSession, user: User, session: Session, new_credential_id: uuid.UUID
) -> AccountRecovery | None:
    """The new passkey is in: under the account's lock, remove every other passkey, end every
    other session, close the request. Unless the partner let this very session in, the day's
    hold starts. -> the row, or None when no request is ready for this session any more (the
    caller then undoes the new passkey)."""
    lock_account(db, user.id)
    if not may_add_passkey(db, user.id, session):
        return None
    row = open_request(db, user.id)
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
    if not (row.partner_approved_at is not None and row.approved_session_id == session.id):
        user.recovered_at = now
    _close(row, "done", None)
    db.flush()
    return row


def hold_if_recovered(user: User) -> None:
    """403 `recently_recovered` for a day after an email-only recovery."""
    if user.recovered_at is not None and _now() - _aware(user.recovered_at) < HOLD:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="recently_recovered")
