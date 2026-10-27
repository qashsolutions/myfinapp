import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.security.authz import Principal
from app.security.step_up import require_fresh_passkey

NOW = datetime(2026, 10, 10, 9, 0, tzinfo=UTC)


def _principal(verified: datetime | None) -> Principal:
    return Principal(uuid.uuid4(), passkey_verified_at=verified)


def test_fresh_passkey_passes() -> None:
    require_fresh_passkey(_principal(NOW - timedelta(minutes=4, seconds=59)), now=NOW)


@pytest.mark.parametrize(
    "verified",
    [
        None,
        NOW - timedelta(minutes=5, seconds=1),
        NOW - timedelta(days=1),
        NOW + timedelta(minutes=1),
    ],
)
def test_stale_missing_or_future_requires_step_up(verified: datetime | None) -> None:
    with pytest.raises(HTTPException) as exc:
        require_fresh_passkey(_principal(verified), now=NOW)
    assert exc.value.status_code == 403
    assert exc.value.detail == "step_up_required"
    assert exc.value.headers == {"X-Step-Up": "passkey"}


def test_max_age_override() -> None:
    p = _principal(NOW - timedelta(minutes=30))
    require_fresh_passkey(p, now=NOW, max_age=timedelta(hours=1))
    with pytest.raises(HTTPException):
        require_fresh_passkey(p, now=NOW, max_age=timedelta(minutes=10))
