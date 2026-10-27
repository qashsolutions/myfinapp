"""Plan history (owner decision, October 18, 2026): what happened to the plan, newest first,
written where it happens, and nobody else's."""

import uuid

import pytest

from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.conftest import stripe_default_transport
from tests.test_billing import member, post_event
from tests.test_billing_cancel import CANCEL, FakeStripe


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    yield
    stripe_billing.transport_override = stripe_default_transport


def event(kind: str, obj: dict) -> dict:
    return {"id": f"evt_{uuid.uuid4().hex}", "type": kind, "data": {"object": obj}}


def test_trial_purchase_cancel_keep_and_end_newest_first() -> None:
    client, user_id = member("hist")
    other, _ = member("nosy")
    assert client.get("/api/billing/history").json() == []

    assert client.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    sub_id = f"sub_{uuid.uuid4().hex[:10]}"
    meta = {"user_id": user_id, "plan": "connected", "interval": "yearly"}
    checkout = {
        "id": "cs_h",
        "mode": "subscription",
        "payment_status": "no_payment_required",  # card saved during the trial
        "client_reference_id": user_id,
        "customer": "cus_h",
        "subscription": sub_id,
        "metadata": meta,
    }
    assert post_event(client, event("checkout.session.completed", checkout)).status_code == 200
    # Stripe's own "created" for the same purchase adds nothing to the history.
    created = {"id": sub_id, "status": "trialing", "customer": "cus_h", "metadata": meta}
    assert post_event(client, event("customer.subscription.created", created)).status_code == 200

    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    assert client.post("/api/billing/cancel", json=CANCEL).status_code == 200
    assert client.post("/api/billing/resume").status_code == 200
    gone = {**created, "status": "canceled"}
    assert post_event(client, event("customer.subscription.deleted", gone)).status_code == 200

    rows = client.get("/api/billing/history").json()
    assert [r["kind"] for r in rows] == [
        "ended",
        "resumed",
        "cancelled",
        "subscribed",
        "trial_started",
    ]
    assert [r["at"] for r in rows] == sorted((r["at"] for r in rows), reverse=True)
    bought = rows[3]
    assert (bought["plan"], bought["interval"], bought["amount_cents"]) == (
        "connected",
        "yearly",
        6500,
    )
    assert rows[2]["until"] is not None  # the date a cancelled plan runs to
    assert other.get("/api/billing/history").json() == []
