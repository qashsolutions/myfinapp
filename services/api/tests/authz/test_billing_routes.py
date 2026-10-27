"""One user's plan is never another's: billing reads are per caller, and only a signed
Stripe event (never a client) can change a subscription."""

import json
import time
import uuid

import pytest

from app.services import stripe_billing
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_plan_is_per_user_and_unsigned_events_change_nothing() -> None:
    alice, bob = new_client(), new_client()
    alice_id = sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    bob_id = sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())["user"][
        "id"
    ]
    grant_plan(alice_id, "connected")

    assert alice.get("/api/billing").json()["plan"] == "connected"
    assert bob.get("/api/billing").json()["plan"] == "free"
    assert bob.get("/api/billing/entitlements").json()["goals_active_max"] == 2

    # Bob cannot upgrade himself by posting an unsigned "event" naming his own id.
    event = {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "mode": "subscription",
                "client_reference_id": bob_id,
                "subscription": "sub_forged",
                "customer": "cus_forged",
                "metadata": {"user_id": bob_id, "plan": "connected", "interval": "yearly"},
            }
        },
    }
    payload = json.dumps(event).encode()
    forged = stripe_billing.sign(payload, "not-the-secret", timestamp=int(time.time()))
    r = bob.post("/api/webhooks/stripe", content=payload, headers={"stripe-signature": forged})
    assert r.status_code == 400
    assert bob.post("/api/webhooks/stripe", content=payload).status_code == 400
    assert bob.get("/api/billing").json()["plan"] == "free"
    assert bob.post("/api/billing/portal").status_code == 404  # no customer of his own
