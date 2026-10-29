"""Invariant 60 (October 29, 2026): a webhook that fails on our side keeps nothing, answers 5xx
so the sender delivers it again, logs the event id and the error code, and tells the admins;
and the dispute's resume is safe to repeat.

Found in the owner's test-mode payments run: a won dispute's `charge.dispute.closed` answered
400 when Stripe refused the first resume of collection, the plan stayed paused, and nobody was
told; the same event sent again worked.
"""

import base64
import json
import logging
import uuid

import httpx2
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import get_session_factory
from app.models.billing import BillingEvent
from app.services import ops_alerts, stripe_billing
from tests.auth_flow import new_client, outbox
from tests.conftest import stripe_default_transport
from tests.test_billing import post_event
from tests.test_billing_oct29 import Stripe, _bought, _dispute, _state

ADMIN = "owner@example.com"


@pytest.fixture(autouse=True)
def _infra(migrated, bucket, monkeypatch):
    outbox().clear()
    ops_alerts.reset_for_tests()
    monkeypatch.setattr(get_settings(), "admin_emails", [ADMIN])
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None
    ops_alerts.reset_for_tests()


def _ops_alerts() -> list[str]:
    return [m.subject for m in outbox() if m.to == ADMIN and m.subject.startswith("Qash error")]


def _recorded(event_id: str) -> bool:
    with get_session_factory()() as db:
        found = db.scalar(select(BillingEvent.id).where(BillingEvent.event_id == event_id))
        return found is not None


class Busy:
    """Stripe answering the first `times` resumes of collection with 429 lock_timeout (the
    subscription is still being changed on Stripe's side as the dispute closes)."""

    def __init__(self, stripe: Stripe, times: int = 1, status: int = 429) -> None:
        self.inner = stripe.transport()
        self.left = times
        self.status = status

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            body = request.content.decode()
            resuming = request.method == "POST" and body == "pause_collection="
            if resuming and self.left > 0:
                self.left -= 1
                return httpx2.Response(
                    self.status,
                    json={"error": {"code": "lock_timeout", "message": "someone@example.com"}},
                )
            return self.inner.handle_request(request)

        return httpx2.MockTransport(handle)


def test_a_won_dispute_stripe_refuses_once_is_retried_not_dropped(caplog) -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("busywin", stripe)
    post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    assert _state(client)["access"]["state"] == "paused"
    outbox().clear()
    stripe_billing.transport_override = Busy(stripe).transport()
    closed = _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "won")
    with caplog.at_level(logging.WARNING, logger="stackd.webhooks"):
        r = post_event(client, closed)
    # Our side failed: 5xx so Stripe delivers it again, never 400
    assert r.status_code == 502, r.text
    assert r.json()["detail"] == "stripe_error"
    assert not _recorded(closed["id"])  # nothing kept, so the retry runs in full
    assert _state(client)["access"]["state"] == "paused"
    # The log names the event and Stripe's code, never its message
    line = next(rec.getMessage() for rec in caplog.records if "webhook failed" in rec.getMessage())
    assert closed["id"] in line and "charge.dispute.closed" in line and "429 lock_timeout" in line
    assert "example.com" not in line
    # The admins are told, with the event type and code but no personal data
    alerts = _ops_alerts()
    assert alerts == [
        "Qash error: stripe_webhook_failed in POST /api/webhooks/stripe charge.dispute.closed: "
        "stripe_error (429 lock_timeout)"
    ]
    assert "Your Qash plan is back" not in [m.subject for m in outbox()]
    # Stripe's retry: the plan comes back, once
    r = post_event(client, closed)
    assert r.status_code == 200 and r.json()["outcome"] == "dispute_won"
    assert _recorded(closed["id"])
    assert _state(client)["access"]["state"] != "paused"
    assert [m.subject for m in outbox()].count("Your Qash plan is back") == 1
    assert post_event(client, closed).json()["outcome"] == "duplicate"


def test_resuming_collection_twice_is_a_no_op_not_a_failure() -> None:
    """Won after `warning_closed` (two closing events), or a subscription Stripe refuses to
    change because it is already resumed or ended: done, not a 4xx."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("twicewin", stripe)
    post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    r = post_event(client, _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "won"))
    assert r.json()["outcome"] == "dispute_won"
    # A second closing event, and Stripe answers this resume with a 400 (nothing to resume)
    stripe_billing.transport_override = Busy(stripe, status=400).transport()
    again = _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "warning_closed")
    r = post_event(client, again)
    assert r.status_code == 200 and r.json()["outcome"] == "dispute_won", r.text
    assert _ops_alerts() == []


def test_a_resume_stripe_refuses_for_a_real_reason_still_fails_loudly() -> None:
    """A 400 while the subscription is still paused at Stripe is a real failure: 502 + alert."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("realfail", stripe)
    post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    stripe_billing.transport_override = Busy(stripe, status=400).transport()
    closed = _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "won")
    r = post_event(client, closed)
    assert r.status_code == 502
    assert not _recorded(closed["id"])
    assert len(_ops_alerts()) == 1


def test_pausing_a_subscription_stripe_already_ended_is_done() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    _bought("endedpause", stripe)
    sub = "sub_a_endedpause"
    stripe.subs[sub]["status"] = "canceled"

    def refuse(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            return httpx2.Response(400, json={"error": {"code": "resource_invalid_state"}})
        return stripe.transport().handle_request(request)

    stripe_billing.transport_override = httpx2.MockTransport(refuse)
    stripe_billing.set_collection_paused(sub, True)  # no raise
    stripe_billing.set_collection_paused(sub, False)  # no raise


def test_an_unexpected_error_is_500_reported_and_nothing_kept(monkeypatch) -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("boom", stripe)

    def boom(*_a, **_k):
        raise RuntimeError("a bug")

    monkeypatch.setattr(stripe_billing, "_dispute", boom)
    created = _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}")
    r = post_event(client, created)
    assert r.status_code == 500 and r.json()["detail"] == "webhook_failed"
    assert not _recorded(created["id"])
    assert _ops_alerts() == [
        "Qash error: stripe_webhook_failed in POST /api/webhooks/stripe "
        "charge.dispute.created: RuntimeError"
    ]


def test_a_bad_signature_is_400_logged_and_not_emailed(caplog) -> None:
    """Owner decision, October 29, 2026: a refused request is logged, never emailed."""
    client = new_client()
    with caplog.at_level(logging.WARNING, logger="stackd.webhooks"):
        r = client.post(
            "/api/webhooks/stripe",
            content=b'{"id": "evt_x", "email": "someone@example.com"}',
            headers={"stripe-signature": "t=1,v1=00", "content-type": "application/json"},
        )
    assert r.status_code == 400 and r.json()["detail"] == "bad_signature"
    line = next(rec.getMessage() for rec in caplog.records if "webhook failed" in rec.getMessage())
    assert "stripe" in line and "bad_signature" in line and "example.com" not in line
    assert _ops_alerts() == []


def test_play_billing_not_configured_is_503_so_pubsub_retries(monkeypatch) -> None:
    """Sibling: Google's webhook answered 400 when our own Play account was missing."""
    monkeypatch.setattr(get_settings(), "store_billing", True)
    monkeypatch.setattr(get_settings(), "play_service_account", None)
    data = {"packageName": get_settings().play_package, "subscriptionNotification": {}}
    data["subscriptionNotification"]["purchaseToken"] = "t" * 20
    rtdn = {
        "message": {
            "messageId": f"m-{uuid.uuid4().hex[:6]}",
            "data": base64.b64encode(json.dumps(data).encode()).decode(),
        }
    }
    r = new_client().post("/api/webhooks/google", json=rtdn)
    assert r.status_code == 503 and r.json()["detail"] == "billing_unavailable"
    assert len(_ops_alerts()) == 1
