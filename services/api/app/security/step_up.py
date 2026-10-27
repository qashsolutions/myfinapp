"""Fresh passkey check for sensitive routes.

docs/spec.md "Account security (day 1)": re-verify with the passkey before linking a bank,
exporting data, deleting the account, changing email or phone, or changing plan, even when
unlocked. How fresh is "fresh" is STACKD_STEP_UP_MAX_AGE_SECONDS (proposed: 5 minutes).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status

from app.config import get_settings
from app.security.authz import Principal


def require_fresh_passkey(
    principal: Principal, *, now: datetime | None = None, max_age: timedelta | None = None
) -> None:
    """Raise 403 `step_up_required` unless the principal passed a passkey check within max_age.

    The client treats `step_up_required` as "prompt for the passkey, then retry".
    """
    now = now or datetime.now(UTC)
    max_age = max_age or timedelta(seconds=get_settings().step_up_max_age_seconds)
    at = principal.passkey_verified_at
    if at is None or at > now or now - at > max_age:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="step_up_required",
            headers={"X-Step-Up": "passkey"},
        )
