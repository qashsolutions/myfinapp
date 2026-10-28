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


def test_a_founding_bank_payment_that_clears_after_the_deletion_is_refunded_in_full() -> None:
    """Owner decision, October 28, 2026: a deleted account is never charged. A US bank
    payment for Founding takes up to 4 business days; if the account was deleted meanwhile,
    the money is refunded in full when it lands (our timing, so no fee), once however often
    Stripe redelivers, and no plan is granted. Before, the deleted account got four years of
    Connected and kept the $150 charge."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.services import deletion, stripe_billing
    from tests.test_billing import member, post_event
    from tests.test_billing_hardening import T0, RefundStripe, _event, _founding_obj

    fake = RefundStripe([])
    stripe_billing.transport_override = fake.transport()
    try:
        client, user_id = member("fgone")
        pi = f"pi_{uuid.uuid4().hex[:8]}"
        pending = _founding_obj(user_id, pi, "unpaid")
        assert (
            post_event(client, _event("checkout.session.completed", pending, T0)).json()["outcome"]
            == "pending"
        )
        assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
        paid = _founding_obj(user_id, pi, "paid")
        for n in range(2):  # Stripe redelivers under a new event id
            r = post_event(
                new_client(), _event("checkout.session.async_payment_succeeded", paid, T0 + 60 + n)
            )
            assert r.status_code == 200 and r.json()["outcome"] == "account_deleted"
        assert fake.intents == {pi: 15000}  # in full, once
        with get_session_factory()() as db:
            row = db.scalar(select(Subscription).where(Subscription.external_id == pi))
            assert row is not None and row.status == "canceled"
            assert row.stripe_status == "canceled" and not row.refund_due_cents
        # Settled: the hourly job has nothing left to do for this account.
        with get_session_factory()() as db, db.begin():
            deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1))
        with get_session_factory()() as db, db.begin():
            assert deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=2)) == 0
    finally:
        stripe_billing.transport_override = None


def test_a_deleted_account_with_a_founding_payment_still_clearing_settles_once() -> None:
    """Sibling of the above (October 28, 2026): a Founding row with no live plan (`incomplete`
    while a bank payment clears, `expired` once it failed) has nothing at Stripe to end, so
    the hourly settle must not pick the deleted account up again every hour."""
    from datetime import UTC, datetime, timedelta

    from app.services import deletion, stripe_billing
    from tests.test_billing import member, post_event
    from tests.test_billing_hardening import T0, RefundStripe, _event, _founding_obj

    stripe_billing.transport_override = RefundStripe([]).transport()
    try:
        for status in ("incomplete", "expired"):
            client, user_id = member(f"f{status}")
            pi = f"pi_{uuid.uuid4().hex[:8]}"
            post_event(
                client,
                _event("checkout.session.completed", _founding_obj(user_id, pi, "unpaid"), T0),
            )
            if status == "expired":
                failed = _founding_obj(user_id, pi, "unpaid")
                post_event(client, _event("checkout.session.async_payment_failed", failed, T0 + 9))
            assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
            counts = []
            for hours in (1, 2):
                with get_session_factory()() as db, db.begin():
                    later = datetime.now(UTC) + timedelta(hours=hours)
                    counts.append(deletion.settle_billing(db, now=later))
            assert counts[1] == 0, status
    finally:
        stripe_billing.transport_override = None


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
