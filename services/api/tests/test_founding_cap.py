"""The Founding offer is the first 250 (200 until October 22, 2026), places left on the site."""

from __future__ import annotations

import uuid

import pytest

from app.db import get_session_factory
from app.models.billing import Subscription
from app.models.user import User
from app.rules_server.entitlements import founding_left
from tests.auth_flow import new_client


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _founding(db, n: int) -> None:
    for _ in range(n):
        user = User(email=f"f-{uuid.uuid4().hex[:10]}@example.com")
        db.add(user)
        db.flush()
        db.add(Subscription(user_id=user.id, plan="founding", status="active", source="stripe"))
    db.flush()


def test_the_website_sees_the_cap_and_places_left() -> None:
    with get_session_factory()() as db:
        cap, before = founding_left(db)
    assert cap == 250
    r = new_client().get("/api/public/plans/founding", headers={"Origin": "https://qash.example"})
    # Another origin is refused; the site's own origin (and no Origin at all) is answered.
    assert r.status_code == 403
    r = new_client().get("/api/public/plans/founding")
    assert r.status_code == 200
    assert r.json() == {"cap": 250, "left": before}
    assert r.headers["cache-control"] == "public, max-age=60"


def test_every_founding_purchase_takes_a_place_and_none_go_below_zero() -> None:
    with get_session_factory()() as db:
        try:
            _, before = founding_left(db)
            _founding(db, 3)
            assert founding_left(db)[1] == max(0, before - 3)
            _founding(db, 250)
            assert founding_left(db)[1] == 0
        finally:
            db.rollback()  # nothing is kept: other tests count from the same table
