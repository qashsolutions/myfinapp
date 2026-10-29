"""Store purchases are checked as Apple checks them, and are off while billing is web-only
(October 29, 2026).

An App Store JWS must come from Apple's App Store signing leaf (marker 1.2.840.113635.100.6.11.1)
under the Worldwide Developer Relations intermediate (1.2.840.113635.100.6.2.1): any other
certificate Apple's root vouches for, a developer's own say, must not sign a purchase. And with
store billing off (owner decision, October 13, 2026), the store webhooks answer 404 and
`/native/sync` 503, so nothing a store signs grants a plan."""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services import native_billing
from app.services.stripe_billing import BillingError
from tests.apple_fake import X5C_NO_INTERMEDIATE_MARKER, X5C_NO_LEAF_MARKER, sign_jws
from tests.auth_flow import new_client, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def txn(user_id: str) -> dict:
    return {
        "originalTransactionId": f"9{uuid.uuid4().int % 10**15:015d}",
        "productId": "com.stackd.app.connected.yearly",
        "bundleId": "com.stackd.app",
        "expiresDate": int((datetime.now(UTC) + timedelta(days=30)).timestamp() * 1000),
        "environment": "Sandbox",
        "appAccountToken": user_id,
    }


def member() -> tuple[TestClient, str]:
    client = new_client()
    sign_up(client, f"s+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    return client, client.get("/api/auth/session").json()["user"]["id"]


@pytest.mark.parametrize("x5c", [X5C_NO_LEAF_MARKER, X5C_NO_INTERMEDIATE_MARKER])
def test_a_chain_without_apples_markers_never_signs_a_purchase(x5c) -> None:
    client, user_id = member()
    jws = sign_jws(txn(user_id), x5c=x5c)
    with pytest.raises(BillingError):
        native_billing.verify_apple_jws(jws)
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": jws})
    assert r.status_code == 400, r.text
    assert client.get("/api/billing").json()["plan"] != "connected"
    # The notification route refuses it too
    assert client.post("/api/webhooks/apple", json={"signedPayload": jws}).status_code == 400


def test_the_real_shape_with_markers_is_accepted() -> None:
    _, user_id = member()
    assert native_billing.verify_apple_jws(sign_jws(txn(user_id)))["appAccountToken"] == user_id


@pytest.fixture
def store_billing_off(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("STACKD_STORE_BILLING", "false")
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as c:
            yield c
    finally:
        get_settings.cache_clear()


def test_with_store_billing_off_nothing_a_store_signs_grants_a_plan(store_billing_off) -> None:
    client, user_id = member()
    jws = sign_jws(txn(user_id))  # a perfectly signed purchase
    assert get_settings().store_billing is False
    r = store_billing_off.post("/api/webhooks/apple", json={"signedPayload": jws})
    assert r.status_code == 404
    assert store_billing_off.post("/api/webhooks/google", json={"message": {}}).status_code == 404
    r = client.post("/api/billing/native/sync", json={"platform": "ios", "jws": jws})
    assert r.status_code == 503 and r.json()["detail"] == "billing_unavailable"
    assert client.get("/api/billing").json()["plan"] != "connected"


def test_store_billing_is_off_unless_switched_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STACKD_STORE_BILLING")
    get_settings.cache_clear()
    try:
        assert get_settings().store_billing is False
    finally:
        get_settings.cache_clear()
