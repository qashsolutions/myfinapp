"""Native billing (Phase 2, chunk 2.4): a store purchase synced from the shell or reported by a
store webhook lands in the same subscriptions table as Stripe, the JWS chain must end at the
pinned root, Play tokens are verified against the API, and one entitlement record follows the
user across web and native."""

import base64
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx2
import pytest

from app.db import get_session_factory
from app.models.billing import Subscription
from app.services import google_auth, native_billing
from tests.apple_fake import sign_jws
from tests.auth_flow import new_client, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    native_billing.transport_override = None
    yield
    native_billing.transport_override = None


def member(name: str):
    client = new_client()
    sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    return client, client.get("/api/auth/session").json()["user"]["id"]


def ms(at: datetime) -> int:
    return int(at.timestamp() * 1000)


def apple_txn(user_id: str | None, product: str, expires: datetime, **extra) -> dict:
    txn = {
        "originalTransactionId": extra.pop("original", "1000000000000001"),
        "productId": product,
        "bundleId": extra.pop("bundle", "com.stackd.app"),
        "expiresDate": ms(expires),
        "environment": "Sandbox",
        **extra,
    }
    if user_id is not None:
        txn["appAccountToken"] = user_id
    return txn


def test_apple_sync_webhooks_and_one_record_across_stores() -> None:
    client, user_id = member("maya")
    future = datetime.now(UTC) + timedelta(days=30)

    # The plan picker gets the product ids from the server
    billing = client.get("/api/billing").json()
    assert billing["store_products"]["connected"]["yearly"] == "com.stackd.app.connected.yearly"

    # Buy on iOS: the signed transaction attaches Connected to the signed-in account
    jws = sign_jws(apple_txn(user_id, "com.stackd.app.connected.yearly", future))
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": jws})
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "connected" and r.json()["source"] == "apple"
    assert r.json()["interval"] == "yearly" and r.json()["status"] == "active"
    assert client.get("/api/billing/entitlements").json()["goals_active_max"] == 10

    # Tampered payload, a chain the pin does not anchor, the wrong bundle: all refused
    head, payload, sig = jws.split(".")
    forged = ".".join(
        [
            head,
            base64.urlsafe_b64encode(
                json.dumps(apple_txn(user_id, "com.stackd.app.private.monthly", future)).encode()
            )
            .decode()
            .rstrip("="),
            sig,
        ]
    )
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": forged})
    assert r.status_code == 400 and r.json()["detail"] == "bad_signature"
    wrong_bundle = sign_jws(
        apple_txn(user_id, "com.stackd.app.connected.yearly", future, bundle="com.evil.app")
    )
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": wrong_bundle})
    assert r.status_code == 400 and r.json()["detail"] == "wrong_bundle"

    # Someone else's signed-in session cannot claim this subscription
    other, other_id = member("dev")
    r = other.post(
        "/api/billing/native/sync",
        json={
            "platform": "ios",
            "jws": sign_jws(apple_txn(user_id, "com.stackd.app.connected.yearly", future)),
        },
    )
    assert r.status_code == 409 and r.json()["detail"] == "wrong_account"
    assert other.get("/api/billing").json()["plan"] == "free"

    # Apple says auto-renew went off: cancel at period end, still Connected
    renewal = sign_jws(
        {"autoRenewStatus": 0, "autoRenewProductId": "com.stackd.app.connected.yearly"}
    )
    note = sign_jws(
        {
            "notificationType": "DID_CHANGE_RENEWAL_STATUS",
            "subtype": "AUTO_RENEW_DISABLED",
            "notificationUUID": "note-1",
            "data": {
                "signedTransactionInfo": sign_jws(
                    apple_txn(user_id, "com.stackd.app.connected.yearly", future)
                ),
                "signedRenewalInfo": renewal,
            },
        }
    )
    r = client.post("/api/webhooks/apple", json={"signedPayload": note})
    assert r.status_code == 200 and r.json()["outcome"] == "synced"
    billing = client.get("/api/billing").json()
    assert billing["plan"] == "connected" and billing["cancel_at_period_end"] is True
    # Redelivery changes nothing
    r = client.post("/api/webhooks/apple", json={"signedPayload": note})
    assert r.json()["outcome"] == "duplicate"

    # It expires: back to Free, same entitlement record
    past = datetime.now(UTC) - timedelta(days=1)
    expired = sign_jws(
        {
            "notificationType": "EXPIRED",
            "notificationUUID": "note-2",
            "data": {
                "signedTransactionInfo": sign_jws(
                    apple_txn(user_id, "com.stackd.app.connected.yearly", past)
                )
            },
        }
    )
    assert client.post("/api/webhooks/apple", json={"signedPayload": expired}).status_code == 200
    assert client.get("/api/billing").json()["plan"] == "free"
    assert client.get("/api/billing/entitlements").json()["goals_active_max"] == 2
    with get_session_factory()() as s:
        rows = s.query(Subscription).filter(Subscription.user_id == uuid.UUID(user_id)).all()
        assert len(rows) == 1 and rows[0].external_id == "apple:1000000000000001"


def play_transport(state: dict) -> httpx2.MockTransport:
    def handle(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "oauth2.googleapis.com":
            return httpx2.Response(200, json={"access_token": "play-access", "expires_in": 3600})
        assert request.url.host == "androidpublisher.googleapis.com"
        assert request.headers["authorization"] == "Bearer play-access"
        state["path"] = request.url.path
        return httpx2.Response(state.get("status", 200), json=state.get("body", {}))

    return httpx2.MockTransport(handle)


def test_play_sync_rtdn_and_cross_store_precedence() -> None:
    client, user_id = member("maya")
    google_auth.reset_cache()
    token = "play-token-" + "z" * 120  # longer than the column; stored as a hash
    future = (datetime.now(UTC) + timedelta(days=14)).isoformat().replace("+00:00", "Z")
    state = {
        "body": {
            "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
            "lineItems": [{"productId": "com.stackd.app.private.monthly", "expiryTime": future}],
            "externalAccountIdentifiers": {"obfuscatedExternalAccountId": user_id},
        }
    }
    native_billing.transport_override = play_transport(state)
    r = client.post(
        "/api/billing/native/sync", json={"platform": "android", "purchase_token": token}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"] == "private" and body["source"] == "google"
    assert "/purchases/subscriptionsv2/tokens/" in state["path"]
    with get_session_factory()() as s:
        row = s.query(Subscription).filter(Subscription.user_id == uuid.UUID(user_id)).one()
        assert row.external_id == native_billing.token_ref(token)
        assert token not in row.external_id

    # The store cannot be fooled by the device: an unknown token is refused
    state["status"] = 404
    r = client.post(
        "/api/billing/native/sync", json={"platform": "android", "purchase_token": "nope" * 8}
    )
    assert r.status_code == 400 and r.json()["detail"] == "unknown_purchase"
    state["status"] = 200

    # RTDN: auto-renew off → cancel at period end (the token is re-verified, not trusted)
    state["body"]["subscriptionState"] = "SUBSCRIPTION_STATE_CANCELED"
    rtdn = {
        "message": {
            "messageId": "m-1",
            "data": base64.b64encode(
                json.dumps(
                    {
                        "version": "1.0",
                        "packageName": "com.stackd.app",
                        "subscriptionNotification": {
                            "notificationType": 3,
                            "purchaseToken": token,
                        },
                    }
                ).encode()
            ).decode(),
        }
    }
    r = client.post("/api/webhooks/google", json=rtdn)
    assert r.status_code == 200 and r.json()["outcome"] == "synced"
    billing = client.get("/api/billing").json()
    assert billing["plan"] == "private" and billing["cancel_at_period_end"] is True
    assert client.post("/api/webhooks/google", json=rtdn).json()["outcome"] == "duplicate"

    # A newer purchase on the web wins: one entitlement record across stores
    grant_plan(user_id, "connected")
    assert client.get("/api/billing").json()["plan"] == "connected"
    assert client.get("/api/billing/entitlements").json()["goals_active_max"] == 10

    # Expiry reported later only touches the Google row
    state["body"]["subscriptionState"] = "SUBSCRIPTION_STATE_EXPIRED"
    rtdn["message"]["messageId"] = "m-2"
    assert client.post("/api/webhooks/google", json=rtdn).json()["outcome"] == "synced"
    assert client.get("/api/billing").json()["plan"] == "connected"


def test_play_rtdn_needs_no_trust_and_other_packages_are_ignored() -> None:
    member("maya")
    native_billing.transport_override = httpx2.MockTransport(lambda request: httpx2.Response(500))
    other_package = {
        "message": {
            "messageId": "m-3",
            "data": base64.b64encode(
                json.dumps(
                    {
                        "packageName": "com.else.where",
                        "subscriptionNotification": {"purchaseToken": "x" * 20},
                    }
                ).encode()
            ).decode(),
        }
    }
    client = new_client()
    r = client.post("/api/webhooks/google", json=other_package)
    assert r.status_code == 200 and r.json()["outcome"] == "ignored"
    # A Play API outage answers 502 so Pub/Sub retries
    google_auth.reset_cache()
    bad = {
        "message": {
            "messageId": "m-4",
            "data": base64.b64encode(
                json.dumps(
                    {
                        "packageName": "com.stackd.app",
                        "subscriptionNotification": {"purchaseToken": "y" * 20},
                    }
                ).encode()
            ).decode(),
        }
    }
    r = client.post("/api/webhooks/google", json=bad)
    assert r.status_code == 502
