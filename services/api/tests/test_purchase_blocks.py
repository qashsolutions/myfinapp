"""A purchase block follows the person (October 27, 2026; docs/invariants.md rule 17): after a
lost dispute or a fraud refund, the inbox can't buy again across an email change, a deletion
and the purge; and a Stripe card / bank block that can't be added is said, never silent."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from sqlalchemy import select, update

from app.config import get_settings
from app.db import get_session_factory
from app.models.billing import PurchaseConsent, Subscription
from app.models.user import User
from app.services import ops_alerts, stripe_billing
from app.services.deletion import purge_due, soft_delete
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import post_event
from tests.test_billing_hardening import FraudStripe, _dispute, _try_to_buy, _warning
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket, monkeypatch):
    monkeypatch.setattr(get_settings(), "admin_emails", ["ops@example.com"])
    ops_alerts.reset_for_tests()
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None
    ops_alerts.reset_for_tests()


class PayerStripe(FraudStripe):
    """FraudStripe plus a checkout page, the block-list lookup, and a list that can go missing."""

    def __init__(self, customer: str) -> None:
        super().__init__(customer)
        self.list_missing = False
        self.listed: set[str] = set()

    def transport(self) -> httpx2.MockTransport:
        base = super().transport()

        def handle(request: httpx2.Request) -> httpx2.Response:
            path, q = request.url.path, dict(request.url.params)
            if path == "/v1/checkout/sessions":
                return httpx2.Response(
                    200, json={"id": "cs_1", "url": "https://checkout.stripe.com/c"}
                )
            if path == "/v1/charges":  # nothing charged after the deletion
                return httpx2.Response(200, json={"data": []})
            if path.startswith("/v1/customers/"):  # no credit left to pay back
                return httpx2.Response(200, json={"id": self.customer, "balance": 0})
            if path == "/v1/radar/value_lists" and self.list_missing:
                return httpx2.Response(200, json={"data": []})
            if path == "/v1/radar/value_list_items" and request.method == "GET":
                hit = q.get("value") in self.listed
                return httpx2.Response(200, json={"data": [{"id": "rsli_x"}] if hit else []})
            response = base.handle_request(request)
            if path == "/v1/radar/value_list_items" and request.method == "POST":
                self.listed.add(self.blocked[-1]["value"])
            return response

        return httpx2.MockTransport(handle)


def _email(tag: str) -> str:
    return f"{tag}+{uuid.uuid4().hex[:6]}@example.com"


def _buyer(email: str):
    """Signs up, agrees to a purchase (the consent the checkout keeps), and holds a plan."""
    client = new_client()
    sign_up(client, email, FakeAuthenticator())
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    customer = f"cus_{uuid.uuid4().hex[:10]}"
    fake = PayerStripe(customer)
    stripe_billing.transport_override = fake.transport()
    assert _try_to_buy(client) == 200
    grant_plan(user_id, "private")
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(Subscription)
            .where(Subscription.user_id == uuid.UUID(user_id))
            .values(customer_id=customer)
        )
    return client, user_id, fake


def _delete(user_id: str) -> None:
    with get_session_factory()() as db:
        # The plan already ended at Stripe, so the deletion has nothing to cancel there.
        db.execute(
            update(Subscription)
            .where(Subscription.user_id == uuid.UUID(user_id))
            .values(status="canceled", stripe_status="canceled", ends_at=datetime.now(UTC))
        )
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        soft_delete(db, user)
        db.commit()


def _purge(user_id: str) -> None:
    with get_session_factory()() as db:
        purge_due(db, grace_days=30, now=datetime.now(UTC) + timedelta(days=31))
        db.commit()
        assert db.get(User, uuid.UUID(user_id)) is None


def _again(email: str):
    client = new_client()
    sign_up(client, email, FakeAuthenticator())
    return client


def _change_email(client, new: str) -> None:
    assert client.post("/api/account/email/send", json={"new_email": new}).status_code == 200
    code = re.search(r"\b(\d{6})\b", outbox()[-1].text).group(1)
    r = client.post("/api/account/email/verify", json={"new_email": new, "code": code})
    assert r.status_code == 200, r.text


def test_a_blocked_account_that_changes_its_email_still_cannot_buy() -> None:
    client, _, fake = _buyer(_email("swap"))
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert _try_to_buy(client) == 403
    new = _email("fresh")
    _change_email(client, new)
    assert _try_to_buy(client) == 403
    # And the new inbox stays blocked after the account is gone and comes back.
    with get_session_factory()() as db:
        assert stripe_billing.inbox_blocked(db, new)


def test_deleting_then_losing_a_dispute_within_the_grace_period_still_blocks_the_inbox() -> None:
    email = _email("grace")
    client, user_id, fake = _buyer(email)
    _delete(user_id)
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert fake.listed == {"fp_stolen"}
    assert _try_to_buy(_again(email)) == 403


def test_a_dispute_lost_after_the_purge_still_blocks_the_inbox_and_the_card() -> None:
    email = _email("purged")
    client, user_id, fake = _buyer(email)
    _delete(user_id)
    _purge(user_id)
    r = post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert r.status_code == 200, r.text
    assert fake.listed == {"fp_stolen"}
    with get_session_factory()() as db:
        assert stripe_billing.inbox_blocked(db, email)
        # The purchase record outlives the account, as the privacy policy says, with no link.
        kept = db.scalars(select(PurchaseConsent).where(PurchaseConsent.user_id.is_(None))).all()
        assert any(c.stripe_customer_id == fake.customer for c in kept)
    assert _try_to_buy(_again(email)) == 403


def test_a_fraud_warning_after_the_purge_still_blocks_the_inbox_and_the_card() -> None:
    email = _email("fraudgone")
    client, user_id, fake = _buyer(email)
    _delete(user_id)
    _purge(user_id)
    post_event(client, _warning())
    assert fake.listed == {"fp_stolen"}
    assert _try_to_buy(_again(email)) == 403


def test_a_card_block_stripe_cannot_take_is_said_to_the_admins() -> None:
    client, _, fake = _buyer(_email("nolist"))
    fake.list_missing = True
    outbox().clear()
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert _try_to_buy(client) == 403  # the inbox block still holds
    alerts = [m for m in outbox() if m.to == "ops@example.com" and "radar_block" in m.text]
    assert len(alerts) == 1


def test_a_card_already_on_the_block_list_is_not_an_error() -> None:
    client, _, fake = _buyer(_email("listed"))
    fake.listed.add("fp_stolen")
    outbox().clear()
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert fake.blocked == []  # not added twice
    assert not [m for m in outbox() if "radar_block" in m.text]
