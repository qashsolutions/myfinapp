"""Per-route abuse limits.

docs/spec.md "Security program": rate limits on code sends, sign-in attempts, invite-code joins,
uploads and exports. Fixed windows are counted in Postgres (rate_limit_buckets) so every API
instance shares one view and nothing new has to be deployed. Keys are stored as pseudonyms.

Values signed off by the owner on October 27, 2026; change them here, never in a router.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session_factory
from app.security.client import client_ip
from app.security.hashing import pseudonym


@dataclass(frozen=True)
class Limit:
    scope: str
    max_hits: int
    window: timedelta


LIMITS: dict[str, Limit] = {
    "otp_send": Limit("otp_send", 5, timedelta(minutes=15)),  # per IP
    "otp_send_email": Limit("otp_send_email", 5, timedelta(minutes=15)),  # per address
    "sign_in": Limit("sign_in", 10, timedelta(minutes=15)),
    # Email-code checks (October 24, 2026): sign-in, email change and the website's deletion.
    # Each code still locks its address after 5 wrong tries; this stops one IP spraying guesses
    # or lockouts across many addresses. Four checks for every code an IP may be sent.
    "otp_verify": Limit("otp_verify", 20, timedelta(minutes=15)),  # per IP
    # Passkey sign-in challenges (October 22, 2026): every visit to the sign-in or Welcome back
    # screen asks for one so a saved passkey can appear in autofill; they share an IP with
    # households, offices and carrier NAT, so they no longer spend the attempts above.
    "passkey_options": Limit("passkey_options", 60, timedelta(minutes=15)),
    "invite_join": Limit("invite_join", 10, timedelta(hours=1)),
    "export": Limit("export", 5, timedelta(hours=24)),  # per signed-in device; each one emails
    # Billing routes that call Stripe live (October 27, 2026): credit, change preview, change,
    # checkout, portal, cancel, resume. Normal use is a handful a visit; a loop can't spend
    # Stripe's API allowance for everyone.
    "billing_stripe": Limit("billing_stripe", 30, timedelta(minutes=15)),  # per session
    "backup_upload": Limit("backup_upload", 60, timedelta(hours=1)),
    "link_start": Limit("link_start", 10, timedelta(hours=1)),
    "link_sync": Limit("link_sync", 120, timedelta(hours=1)),  # pages of a big first sync
    # "Link with your phone" (October 19, 2026): 3 requests an hour per IP is the owner's figure;
    # the computer checks every 2 seconds for up to 2 minutes; lookups stop code guessing.
    "device_link_start": Limit("device_link_start", 3, timedelta(hours=1)),
    "device_link_status": Limit("device_link_status", 150, timedelta(minutes=10)),
    "device_link_lookup": Limit("device_link_lookup", 10, timedelta(minutes=15)),
    # Security routes whose success sends an always-on alert email (signed off October 28,
    # 2026): 10 a day per signed-in device each, so a stolen or scripted session can't flood
    # the owner's inbox. Failed attempts count too.
    **{
        scope: Limit(scope, 10, timedelta(hours=24))
        for scope in (
            "passkey_add",  # POST /api/security/passkeys/register/verify
            "passkey_remove",  # DELETE /api/security/passkeys/{id}
            "device_sign_out",  # DELETE /api/security/devices/{id}
            "device_link_approve",  # POST /api/auth/link/approve (the new device's alert)
            "device_link_deny",  # POST /api/auth/link/deny (an audit row each; October 28, 2026)
            "backup_key",  # PUT /api/backup/key
            "backup_off",  # DELETE /api/backup
            "tester_plan",  # POST /api/billing/tester
            "bank_link_finish",  # POST /api/linking/finish
            "bank_disconnect",  # DELETE /api/linking/{id}
        )
    },
}


@dataclass(frozen=True)
class Decision:
    allowed: bool
    hits: int
    remaining: int
    retry_after: int  # seconds until the window resets; 0 when allowed


def window_start(now: datetime, window: timedelta) -> datetime:
    seconds = int(window.total_seconds())
    epoch = int(now.timestamp())
    return datetime.fromtimestamp(epoch - epoch % seconds, tz=UTC)


_UPSERT = text(
    """
    INSERT INTO rate_limit_buckets (scope, key, window_start, hits)
    VALUES (:scope, :key, :start, 1)
    ON CONFLICT (scope, key, window_start)
    DO UPDATE SET hits = rate_limit_buckets.hits + 1
    RETURNING hits
    """
)
_EXPIRE = text(
    "DELETE FROM rate_limit_buckets WHERE scope = :scope AND key = :key AND window_start < :start"
)


def hit(session: Session, limit: Limit, key: str, *, now: datetime | None = None) -> Decision:
    """Count one attempt for `key` in `limit.scope` and decide. Blocked attempts count too."""
    now = now or datetime.now(UTC)
    start = window_start(now, limit.window)
    params = {"scope": limit.scope, "key": pseudonym(key), "start": start}
    hits = int(session.execute(_UPSERT, params).scalar_one())
    session.execute(_EXPIRE, params)
    allowed = hits <= limit.max_hits
    reset_in = math.ceil((start + limit.window - now).total_seconds())
    return Decision(
        allowed=allowed,
        hits=hits,
        remaining=max(0, limit.max_hits - hits),
        retry_after=0 if allowed else max(1, reset_in),
    )


def session_or_ip(request: Request) -> str:
    """Count per signed-in device (a keyed pseudonym of its session cookie), else per IP: for
    routes that need a session, so many people behind one address don't share a limit."""
    token = request.cookies.get("stackd_session")
    return f"s:{pseudonym(token)}" if token else client_ip(request)


def rate_limited(
    scope: str, *, key: Callable[[Request], str] = client_ip
) -> Callable[[Request], Decision]:
    """FastAPI dependency factory: `Depends(rate_limited("otp_send"))`.

    Counts in its own transaction, so an attempt is recorded even when the request then fails
    (a failed sign-in must still count). 429 carries Retry-After in seconds.
    """
    limit = LIMITS[scope]

    def dependency(request: Request) -> Decision:
        with get_session_factory()() as session, session.begin():
            decision = hit(session, limit, key(request))
        if not decision.allowed:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail="rate_limited",
                headers={"Retry-After": str(decision.retry_after)},
            )
        return decision

    return dependency
