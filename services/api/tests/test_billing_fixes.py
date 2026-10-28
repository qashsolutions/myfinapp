"""Billing fixes (October 28, 2026): never two plans while a bank payment clears or beside a
store plan, Founding ends with its term, a failed first bank payment leaves the account where
it was, receipts after a plan ends, and store proofs that can't be replayed, smuggled into a
URL or quietly applied to another account."""

import base64
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs import plan_lifecycle
from app.models.billing import Subscription
from app.services import google_auth, native_billing, stripe_billing
from tests.apple_fake import sign_jws
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import FakeStripe, buy, member, post_event
from tests.test_billing_hardening import T0, _checkout_obj, _event, _founding_obj
from tests.test_native_billing import apple_txn, ms


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    native_billing.transport_override = None
    yield
    stripe_billing.transport_override = None
    native_billing.transport_override = None


def _rows(user_id: str) -> list[Subscription]:
    with get_session_factory()() as db:
        return list(
            db.scalars(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        )


def _set(user_id: str, **fields) -> None:
    with get_session_factory()() as db:
        for row in db.scalars(
            select(Subscription).where(Subscription.user_id == uuid.UUID(user_id))
        ):
            for k, v in fields.items():
                setattr(row, k, v)
        db.commit()


# --- 1. Never a second purchase while a bank payment clears ---------------------------------


def test_no_second_purchase_while_a_first_bank_payment_clears() -> None:
    """Invariant 14 (one count, read the same everywhere): the plan waits on a clearing bank
    debit, and so must checkout, or a card purchase makes two live subscriptions."""
    client, user_id = member("pend1")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(
        client, _event("checkout.session.completed", _checkout_obj(sub, user_id, "unpaid"), T0)
    )
    assert client.get("/api/billing").json()["payment_pending"] is True
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    for body in (buy(client, plan="connected", interval="monthly"), buy(client, plan="founding")):
        r = client.post("/api/billing/checkout", json=body)
        assert r.status_code == 409 and r.json()["detail"] == "payment_pending"
    assert stripe.requests == []


def test_no_second_purchase_while_a_founding_place_is_held() -> None:
    client, user_id = member("pend2")
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    post_event(
        client, _event("checkout.session.completed", _founding_obj(user_id, pi, "unpaid"), T0)
    )
    assert client.get("/api/billing").json()["payment_pending"] is True
    r = client.post("/api/billing/checkout", json=buy(client, plan="private", interval="yearly"))
    assert r.status_code == 409 and r.json()["detail"] == "payment_pending"


# --- 2. Founding ends with its term ----------------------------------------------------------


def test_founding_ends_with_its_term_and_says_so_first() -> None:
    client, user_id = member("fend")
    grant_plan(user_id, "founding")
    assert client.get("/api/billing").json()["plan"] == "founding"
    now = datetime.now(UTC)
    _set(user_id, ends_at=now + timedelta(hours=12))
    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now, only={uuid.UUID(user_id)})["ending_soon"] == 1
    assert outbox()[-1].subject == "Your Founding membership ends tomorrow"
    _set(user_id, ends_at=now - timedelta(hours=1))
    billing = client.get("/api/billing").json()
    assert billing["plan"] == "free"
    assert billing["entitlements"]["access"]["state"] == "lapsed"
    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now, only={uuid.UUID(user_id)})["ended"] == 1


# --- 3. Not beside a store plan --------------------------------------------------------------


def test_web_checkout_refuses_beside_a_live_store_plan() -> None:
    client, user_id = member("store1")
    with get_session_factory()() as db:
        db.add(
            Subscription(
                user_id=uuid.UUID(user_id),
                plan="private",
                source="apple",
                external_id=f"apple:{uuid.uuid4().int % 10**15}",
                status="active",
                interval="monthly",
                renews_at=datetime.now(UTC) + timedelta(days=20),
            )
        )
        db.commit()
    for body in (buy(client, plan="connected", interval="yearly"), buy(client, plan="founding")):
        r = client.post("/api/billing/checkout", json=body)
        assert r.status_code == 409 and r.json()["detail"] == "manage_in_store"


# --- 4. A failed first bank payment leaves the account where it was --------------------------


def test_a_failed_first_bank_payment_keeps_the_trial_on_offer() -> None:
    """Invariant 15: the access state says what is true. A plan that never started never
    ended, so the account is still choosing and may start its one trial."""
    client, user_id = member("failfirst")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    unpaid = _checkout_obj(sub, user_id, "unpaid")
    post_event(client, _event("checkout.session.completed", unpaid, T0))
    post_event(client, _event("checkout.session.async_payment_failed", unpaid, T0 + 60))
    access = client.get("/api/billing/entitlements").json()["access"]
    assert access == {"state": "choose", "plan": "free", "trial_used": False}
    assert client.post("/api/billing/trial", json={"plan": "private"}).status_code == 200


def test_a_failed_founding_bank_payment_keeps_the_trial_on_offer() -> None:
    client, user_id = member("failfound")
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    post_event(
        client, _event("checkout.session.completed", _founding_obj(user_id, pi, "unpaid"), T0)
    )
    post_event(
        client,
        _event(
            "checkout.session.async_payment_failed", _founding_obj(user_id, pi, "unpaid"), T0 + 60
        ),
    )
    assert client.get("/api/billing/entitlements").json()["access"]["state"] == "choose"


# --- 5. Receipts after a plan ends -----------------------------------------------------------


def test_receipts_stay_reachable_after_a_plan_ends() -> None:
    client, user_id = member("receipts")
    grant_plan(user_id, "private")
    _set(user_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(days=2))
    billing = client.get("/api/billing").json()
    assert billing["plan"] == "free" and billing["has_customer"] is True
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    r = client.post("/api/billing/portal")
    assert r.status_code == 200, r.text
    customer = _rows(user_id)[0].customer_id
    assert f"customer={customer}" in stripe.requests[-1].content.decode()


# --- 6. An old Apple proof never overrides a newer one ---------------------------------------


def test_an_old_apple_transaction_never_undoes_a_refund() -> None:
    client, user_id = member("replay")
    original = str(2000000000000000 + uuid.uuid4().int % 10**15)
    future = datetime.now(UTC) + timedelta(days=30)
    signed = datetime.now(UTC) - timedelta(hours=2)
    product = "com.stackd.app.connected.yearly"
    purchase = sign_jws(
        apple_txn(user_id, product, future, original=original, signedDate=ms(signed))
    )
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": purchase})
    assert r.status_code == 200 and r.json()["plan"] == "connected"
    refunded = apple_txn(
        user_id,
        product,
        future,
        original=original,
        signedDate=ms(signed + timedelta(hours=1)),
        revocationDate=ms(signed + timedelta(hours=1)),
    )
    note = sign_jws(
        {
            "notificationType": "REFUND",
            "notificationUUID": f"refund-{original}",
            "data": {"signedTransactionInfo": sign_jws(refunded)},
        }
    )
    assert client.post("/api/webhooks/apple", json={"signedPayload": note}).status_code == 200
    assert client.get("/api/billing").json()["plan"] == "free"
    # Re-sending the purchase's own proof changes nothing.
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": purchase})
    assert r.status_code == 200 and r.json()["plan"] == "free"


# --- 7. A Play token is checked before it goes anywhere --------------------------------------


def test_a_play_token_outside_the_pattern_is_refused_and_never_sent() -> None:
    client, _ = member("playtok")
    seen: list[str] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(str(request.url))
        return httpx2.Response(500)

    native_billing.transport_override = httpx2.MockTransport(handle)
    google_auth.reset_cache()
    for token in ("../../../applications/x?y=1", "a/b", "tok en", "x" * 5000, ""):
        r = client.post(
            "/api/billing/native/sync", json={"platform": "android", "purchase_token": token}
        )
        assert r.status_code == 422, (token, r.text)
    rtdn = {
        "message": {
            "messageId": f"m-{uuid.uuid4().hex}",
            "data": base64.b64encode(
                json.dumps(
                    {
                        "packageName": "com.stackd.app",
                        "subscriptionNotification": {"purchaseToken": "../../x?y=1#"},
                    }
                ).encode()
            ).decode(),
        }
    }
    r = client.post("/api/webhooks/google", json=rtdn)
    assert r.status_code == 200 and r.json()["outcome"] == "ignored"
    assert seen == []


# --- 8. Someone else's proof is refused, not quietly applied ---------------------------------


def test_a_proof_already_linked_to_another_account_is_refused() -> None:
    owner, owner_id = member("ownerA")
    other, _ = member("otherB")
    original = str(3000000000000000 + uuid.uuid4().int % 10**15)
    future = datetime.now(UTC) + timedelta(days=30)
    product = "com.stackd.app.private.monthly"
    # Bought without an account token (an old purchase), synced by its owner first.
    proof = sign_jws(apple_txn(None, product, future, original=original))
    assert (
        owner.post("/api/billing/native/sync", json={"platform": "ios", "jws": proof}).json()[
            "plan"
        ]
        == "private"
    )
    r = other.post("/api/billing/native/sync", json={"platform": "ios", "jws": proof})
    assert r.status_code == 409 and r.json()["detail"] == "wrong_account"
    assert [row.user_id for row in _rows(owner_id)] == [uuid.UUID(owner_id)]
