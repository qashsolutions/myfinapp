"""Buying a plan that doesn't link disconnects the banks, and says so first (owner decision,
November 26, 2026; hard constraint 3, invariant 98). Found by the Connected payments
regression: a Connected trial with a bank, then Private bought at checkout, kept the bank
connected at Plaid (unread) until 60 days unused, while switching down said so and
disconnected at once. One rule now: a live plan that doesn't link never holds a connection."""

import json
import time
import uuid

import pytest
from sqlalchemy import text

from app.db import get_session_factory
from app.linking import plaid
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import purchase_consent
from tests.conftest import stripe_default_transport
from tests.plaid_fake import FakePlaid
from tests.test_billing import FakeStripe, buy, member, post_event
from tests.test_linking import start

LINE = "Private doesn't link banks: yours are disconnected now. Accounts and entries stay."


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None
    plaid.transport_override = None


@pytest.fixture
def fake() -> FakePlaid:
    f = FakePlaid()
    plaid.transport_override = f.transport()
    return f


def linked_trial(fake: FakePlaid, name: str):
    """A Connected trial with a bank linked, then the trial over."""
    client, user_id = member(name)
    assert client.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    session_id = start(client, fake, "First Platypus Bank")
    assert client.post("/api/linking/finish", json={"session_id": session_id}).status_code == 200
    assert len(client.get("/api/linking").json()["connections"]) == 1
    with get_session_factory()() as db, db.begin():
        db.execute(
            text("UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE id = :u"),
            {"u": user_id},
        )
    return client, user_id


def completed(user_id: str, plan: str, *, paid: bool = True) -> dict:
    return {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": f"cs_{uuid.uuid4().hex[:8]}",
                "mode": "subscription",
                "payment_status": "paid" if paid else "unpaid",
                "client_reference_id": user_id,
                "customer": "cus_links",
                "subscription": f"sub_{uuid.uuid4().hex[:8]}",
                "metadata": {"user_id": user_id, "plan": plan, "interval": "monthly"},
            }
        },
    }


def lines(client, plan: str) -> list[str]:
    return purchase_consent(client, plan, "monthly")["lines"]


def test_buying_private_with_a_bank_says_so_first_then_disconnects_it_at_plaid(
    fake: FakePlaid,
) -> None:
    client, user_id = linked_trial(fake, "privlinks")
    assert LINE in lines(client, "private")  # said before the payment page opens
    assert not any("link banks" in x for x in lines(client, "connected"))
    stripe_billing.transport_override = FakeStripe().transport()
    r = client.post("/api/billing/checkout", json=buy(client, plan="private", interval="monthly"))
    assert r.status_code == 200, r.text
    assert len(client.get("/api/linking").json()["connections"]) == 1  # nothing yet: not paid
    stripe_billing.transport_override = stripe_default_transport()
    r = post_event(client, completed(user_id, "private"))
    assert r.status_code == 200 and r.json()["outcome"] == "subscribed"
    assert fake.removed == fake.access_tokens()  # revoked at Plaid, not just hidden
    assert client.get("/api/linking").json()["connections"] == []
    with get_session_factory()() as db:
        audited = db.execute(
            text(
                "SELECT count(*) FROM audit_log WHERE actor_id = :u "
                "AND action = 'bank_disconnected'"
            ),
            {"u": user_id},
        ).scalar_one()
    assert audited == 1


def test_no_bank_no_line_and_connected_keeps_its_banks(fake: FakePlaid) -> None:
    client, _ = member("nolinks")
    assert client.post("/api/billing/trial", json={"plan": "private"}).status_code == 200
    assert not any("link banks" in x for x in lines(client, "private"))
    other, other_id = linked_trial(fake, "connlinks")
    post_event(other, completed(other_id, "connected"))
    assert fake.removed == []
    assert len(other.get("/api/linking").json()["connections"]) == 1


def test_a_bank_payment_still_clearing_disconnects_nothing_until_the_plan_starts(
    fake: FakePlaid,
) -> None:
    client, user_id = linked_trial(fake, "pending")
    event = completed(user_id, "private", paid=False)
    assert post_event(client, event).status_code == 200
    assert fake.removed == []  # the payment may still fail: the bank stays
    assert len(client.get("/api/linking").json()["connections"]) == 1
    cleared = json.loads(json.dumps(event))
    cleared["id"], cleared["type"] = (
        f"evt_{uuid.uuid4().hex}",
        ("checkout.session.async_payment_succeeded"),
    )
    cleared["data"]["object"]["payment_status"] = "paid"
    time.sleep(1)
    assert post_event(client, cleared).status_code == 200
    assert fake.removed == fake.access_tokens()


def test_plaid_down_at_the_start_marks_it_for_the_retry_job(fake: FakePlaid) -> None:
    client, user_id = linked_trial(fake, "plaiddown")
    fake.fail_remove = True
    assert post_event(client, completed(user_id, "private")).status_code == 200
    # Hidden now, its token kept sealed for `stackd-api revoke-links` to revoke (invariant 72).
    assert client.get("/api/linking").json()["connections"] == []
    with get_session_factory()() as db:
        assert db.execute(
            text("SELECT status FROM bank_connections WHERE user_id = :u"), {"u": user_id}
        ).scalars().all() == ["revoke_pending"]


def test_a_store_plan_that_doesnt_link_disconnects_too_and_a_lapsed_one_keeps_them(
    fake: FakePlaid,
) -> None:
    """Sibling paths: the App Store and Google Play sync (off for now, but live code)."""
    from datetime import UTC, datetime, timedelta

    from app.services import google_auth, native_billing
    from tests.apple_fake import sign_jws
    from tests.test_native_billing import apple_txn, play_transport

    future = datetime.now(UTC) + timedelta(days=30)
    # An expired Private purchase is no live plan: the bank stays, unread, for a return.
    client, user_id = linked_trial(fake, "storegone")
    past = datetime.now(UTC) - timedelta(days=1)
    jws = sign_jws(apple_txn(user_id, "com.stackd.app.private.monthly", past, original="91"))
    assert (
        client.post("/api/billing/native/sync", json={"platform": "ios", "jws": jws}).status_code
        == 200
    )
    assert fake.removed == []
    # A live one disconnects, on iOS…
    jws = sign_jws(apple_txn(user_id, "com.stackd.app.private.monthly", future, original="92"))
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": jws})
    assert r.status_code == 200 and r.json()["plan"] == "private"
    assert fake.removed == fake.access_tokens()
    # …and on Android.
    other, other_id = linked_trial(fake, "storeplay")
    google_auth.reset_cache()
    native_billing.transport_override = play_transport(
        {
            "body": {
                "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
                "lineItems": [
                    {
                        "productId": "com.stackd.app.private.monthly",
                        "expiryTime": future.isoformat().replace("+00:00", "Z"),
                    }
                ],
                "externalAccountIdentifiers": {"obfuscatedExternalAccountId": other_id},
            }
        }
    )
    try:
        r = other.post(
            "/api/billing/native/sync",
            json={"platform": "android", "purchase_token": "play-" + "y" * 40},
        )
        assert r.status_code == 200, r.text
    finally:
        native_billing.transport_override = None
    assert other.get("/api/linking").json()["connections"] == []
