"""One-time sign-in codes (docs/spec.md "Authentication").

6 digits, valid 10 minutes, single use, 5 wrong tries then a 15-minute lockout, and a
resend cooldown. All values are settings (owner sign-off, October 27, 2026). Codes are
stored hashed.
"""

from __future__ import annotations

import math
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.otp_code import OtpCode
from app.security.hashing import pseudonym, token_hash

CODE_LENGTH = 6


class OtpError(Exception):
    """`code` is a stable snake_case reason; `retry_after` is seconds when waiting helps."""

    def __init__(
        self,
        code: str,
        *,
        retry_after: int | None = None,
        attempts_left: int | None = None,
        just_locked: bool = False,
    ):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after
        self.attempts_left = attempts_left
        self.just_locked = just_locked  # this attempt started the lockout: tell the owner once


def normalize_email(email: str) -> str:
    return email.strip().lower()


GMAIL_DOMAINS = {"gmail.com", "googlemail.com"}


def canonical_email(email: str) -> str:
    """The inbox an address delivers to, for "one per person" rules such as the free trial
    (owner decision, October 24, 2026): a "+tag" is dropped for every provider, and Gmail's
    dots and googlemail.com are folded. Sign-in and mail still use the address as typed."""
    local, _, domain = normalize_email(email).rpartition("@")
    if not local:
        return normalize_email(email)
    local = local.split("+", 1)[0] or local
    if domain in GMAIL_DOMAINS:
        local, domain = local.replace(".", "") or local, "gmail.com"
    return f"{local}@{domain}"


def generate_code() -> str:
    return f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"


def _seconds_until(when: datetime, now: datetime) -> int:
    return max(1, math.ceil((when - now).total_seconds()))


def _latest(db: DbSession, email: str) -> OtpCode | None:
    """The address's newest code, locked until the caller commits (invariant 32): guesses sent
    at once are judged one after another, each seeing the attempts the one before counted, so
    the lockout comes after the fifth wrong code however many arrive together, and a code is
    consumed once. `populate_existing` reads the row as the lock found it."""
    stmt = (
        select(OtpCode)
        .where(OtpCode.email == email)
        .order_by(OtpCode.created_at.desc())
        .limit(1)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return db.scalars(stmt).first()


SIGN_IN = "sign_in"
DELETE_ACCOUNT = "delete_account"


def email_change_purpose(user_id: object) -> str:
    """An email-change code works only for the account that asked for it (after step-up)."""
    return f"email_change:{user_id}"


def _hash(purpose: str, email: str, code: str) -> str:
    # The purpose is in the hash, so a code minted for one use (say the public sign-in send,
    # which answers for any address) never verifies for another. Sign-in keeps the old form.
    base = f"{email}:{code}"
    return token_hash(base if purpose == SIGN_IN else f"{purpose}|{base}")


def request_code(
    db: DbSession,
    email: str,
    *,
    ip: str | None,
    purpose: str = SIGN_IN,
    now: datetime | None = None,
) -> tuple[str, OtpCode]:
    """Issue a fresh code for `email` and `purpose`, retiring any earlier one. -> (code, row)."""
    s = get_settings()
    now = now or datetime.now(UTC)
    latest = _latest(db, email)
    if latest is not None:
        if latest.locked_until and latest.locked_until > now:
            raise OtpError("locked", retry_after=_seconds_until(latest.locked_until, now))
        resend_at = latest.created_at + timedelta(seconds=s.otp_resend_seconds)
        if resend_at > now and latest.consumed_at is None:
            raise OtpError("too_soon", retry_after=_seconds_until(resend_at, now))
        if latest.consumed_at is None:
            latest.consumed_at = now  # only the newest code is ever valid
    code = generate_code()
    row = OtpCode(
        email=email,
        code_hash=_hash(purpose, email, code),
        expires_at=now + timedelta(seconds=s.otp_ttl_seconds),
        ip_hash=pseudonym(ip) if ip else None,
        created_at=now,
    )
    db.add(row)
    db.flush()
    return code, row


def verify_code(
    db: DbSession,
    email: str,
    code: str,
    *,
    purpose: str = SIGN_IN,
    now: datetime | None = None,
) -> OtpCode:
    """Consume the current code for `email` if `code` matches and was issued for `purpose`;
    otherwise count the attempt."""
    s = get_settings()
    now = now or datetime.now(UTC)
    latest = _latest(db, email)
    if latest is not None and latest.locked_until and latest.locked_until > now:
        raise OtpError("locked", retry_after=_seconds_until(latest.locked_until, now))
    if latest is None or latest.consumed_at is not None:
        raise OtpError("no_code")
    if latest.expires_at <= now:
        latest.consumed_at = now
        raise OtpError("expired")
    if not secrets.compare_digest(latest.code_hash, _hash(purpose, email, code.strip())):
        latest.attempts += 1
        if latest.attempts >= s.otp_max_attempts:
            latest.consumed_at = now
            latest.locked_until = now + timedelta(seconds=s.otp_lockout_seconds)
            db.flush()
            raise OtpError("locked", retry_after=s.otp_lockout_seconds, just_locked=True)
        db.flush()
        raise OtpError("wrong_code", attempts_left=s.otp_max_attempts - latest.attempts)
    latest.consumed_at = now
    db.flush()
    return latest
