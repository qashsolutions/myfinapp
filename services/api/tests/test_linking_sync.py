"""Linked sync and webhooks (chunk 3.3): pass-through, cursor paging, connection status, and
webhook signatures checked the way Plaid signs them."""

import base64
import hashlib
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from sqlalchemy import select

from app.db import get_session_factory
from app.linking import plaid, webhook_verify
from app.models.linking import BankConnection
from tests.auth_flow import new_client, outbox
from tests.plaid_fake import FakePlaid
from tests.test_linking import member, start

PLAID_TXN = {
    "transaction_id": "txn-1",
    "account_id": "acc-chk",
    "date": "2026-10-10",
    "amount": 12.345,  # rounds half-even to 1234 cents
    "merchant_name": "Blue Bottle Coffee",
    "name": "BLUE BOTTLE #22",
    "pending": False,
    "pending_transaction_id": None,
    "personal_finance_category": {"primary": "FOOD_AND_DRINK"},
    "location": {"city": "Oakland"},
    "logo_url": "https://logo.example/blue.png",
    "payment_channel": "in store",
}


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    plaid.transport_override = None
    webhook_verify.reset()
    yield
    plaid.transport_override = None
    webhook_verify.reset()


@pytest.fixture
def fake() -> FakePlaid:
    f = FakePlaid()
    plaid.transport_override = f.transport()
    return f


def linked(fake: FakePlaid, name: str = "maya"):
    client, user_id = member(name)
    session_id = start(client, fake, "First Platypus Bank")
    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.status_code == 200, r.text
    conn_id = r.json()["connections"][0]["id"]
    access = fake.access_tokens()[-1]
    return client, user_id, conn_id, access


def test_sync_passes_through_only_what_the_rules_read(fake: FakePlaid) -> None:
    client, _, conn_id, access = linked(fake)
    refund = {
        **PLAID_TXN,
        "transaction_id": "txn-2",
        "amount": -20,
        "merchant_name": None,
        "name": "REFUND STORE",
    }
    fake.queue_sync(
        access,
        {
            "added": [PLAID_TXN, refund],
            "accounts": [
                {"account_id": "acc-chk", "type": "depository", "balances": {"current": 1500.5}},
                {"account_id": "acc-cc", "type": "credit", "balances": {"current": 410}},
            ],
        },
    )
    r = client.post(f"/api/linking/{conn_id}/sync", json={"cursor": None})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["added"] == [
        {
            "transaction_id": "txn-1",
            "account_id": "acc-chk",
            "date": "2026-10-10",
            "direction": "out",
            "amount_cents": 1234,
            "description": "Blue Bottle Coffee",
            "pending": False,
            "pending_transaction_id": None,
        },
        {
            "transaction_id": "txn-2",
            "account_id": "acc-chk",
            "date": "2026-10-10",
            "direction": "in",
            "amount_cents": 2000,
            "description": "REFUND STORE",
            "pending": False,
            "pending_transaction_id": None,
        },
    ]
    assert out["balances"] == [
        {"account_id": "acc-chk", "current_cents": 150050, "type": "depository"},
        {"account_id": "acc-cc", "current_cents": 41000, "type": "credit"},
    ]
    assert out["next_cursor"].startswith("cursor-")
    assert out["has_more"] is False
    text = r.text
    for leaked in ("FOOD_AND_DRINK", "Oakland", "logo.example", "in store"):
        assert leaked not in text  # provider categories and extras never reach the device
    with get_session_factory()() as db:
        row = db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))
        assert row is not None and row.last_synced_at is not None
        # Nothing about the transactions is kept: the row has no column that could hold them.
        assert "Blue Bottle" not in json.dumps(
            {c.name: str(getattr(row, c.name)) for c in row.__table__.columns}
        )


def test_sync_pages_from_the_device_cursor_and_restarts_on_mutation(fake: FakePlaid) -> None:
    client, _, conn_id, access = linked(fake)
    fake.queue_sync(
        access, {"added": [PLAID_TXN], "has_more": True}, {"removed": [{"transaction_id": "old"}]}
    )
    fake.mutation_once = True
    r = client.post(f"/api/linking/{conn_id}/sync", json={"cursor": "cursor-from-device"})
    assert r.status_code == 200, r.text
    calls = fake.bodies("/transactions/sync")
    assert calls[0]["cursor"] == "cursor-from-device"  # the failed first try
    assert calls[1]["cursor"] == "cursor-from-device"  # restarted from the same cursor
    assert calls[2]["cursor"].startswith("cursor-")  # then the next page
    out = r.json()
    assert [t["transaction_id"] for t in out["added"]] == ["txn-1"]
    assert out["removed"] == ["old"]
    assert out["has_more"] is False


def test_login_required_marks_the_connection_and_a_good_sync_clears_it(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    r = client.post(f"/api/linking/{conn_id}/sync", json={})
    assert r.status_code == 409 and r.json()["detail"] == "login_required"
    [conn] = client.get("/api/linking").json()["connections"]
    assert conn["status"] == "login_required"
    fake.sync_error = None
    assert client.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 200
    assert client.get("/api/linking").json()["connections"][0]["status"] == "ok"


def test_someone_elses_connection_is_not_found(fake: FakePlaid) -> None:
    _, _, conn_id, _ = linked(fake, "maya")
    other, _ = member("sam")
    assert other.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 404


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign(fake: FakePlaid, body: bytes, *, iat: float | None = None, kid: str | None = None) -> str:
    header = _b64(json.dumps({"alg": "ES256", "kid": kid or fake.key_id, "typ": "JWT"}).encode())
    claims = _b64(
        json.dumps(
            {
                "iat": int(iat if iat is not None else time.time()),
                "request_body_sha256": hashlib.sha256(body).hexdigest(),
            }
        ).encode()
    )
    der = fake.signing_key.sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{header}.{claims}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def item_of(conn_id: str) -> str:
    with get_session_factory()() as db:
        row = db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))
        assert row is not None
        return row.item_id


def test_webhook_flags_updates_and_status_only_with_a_valid_signature(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    item = item_of(conn_id)
    hook = new_client()

    body = json.dumps(
        {"webhook_type": "TRANSACTIONS", "webhook_code": "SYNC_UPDATES_AVAILABLE", "item_id": item}
    ).encode()
    r = hook.post(
        "/api/webhooks/plaid", content=body, headers={"Plaid-Verification": sign(fake, body)}
    )
    assert r.status_code == 200 and r.json()["outcome"] == "updates_available"
    assert client.get("/api/linking").json()["connections"][0]["updates_available"] is True

    # Tampered body, stale token, unknown key: all refused, nothing changes.
    other = json.dumps(
        {"webhook_type": "ITEM", "webhook_code": "USER_PERMISSION_REVOKED", "item_id": item}
    ).encode()
    bad = [
        sign(fake, body),  # signed a different body
        sign(fake, other, iat=time.time() - 3600),
        sign(fake, other, kid="kid-unknown"),
        "not.a.jwt",
    ]
    for token in bad:
        r = hook.post("/api/webhooks/plaid", content=other, headers={"Plaid-Verification": token})
        assert r.status_code == 400, token
    assert client.get("/api/linking").json()["connections"][0]["status"] == "ok"

    r = hook.post(
        "/api/webhooks/plaid", content=other, headers={"Plaid-Verification": sign(fake, other)}
    )
    assert r.json()["outcome"] == "revoked"
    assert client.get("/api/linking").json()["connections"][0]["status"] == "revoked"
    assert (
        client.post(f"/api/linking/{conn_id}/sync", json={}).json()["detail"]
        == "connection_revoked"
    )

    # A sync clears the updates flag.
    fake2 = json.dumps(
        {"webhook_type": "ITEM", "webhook_code": "LOGIN_REPAIRED", "item_id": item}
    ).encode()
    hook.post(
        "/api/webhooks/plaid", content=fake2, headers={"Plaid-Verification": sign(fake, fake2)}
    )
    assert client.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 200
    conn = client.get("/api/linking").json()["connections"][0]
    assert conn["status"] == "ok" and conn["updates_available"] is False


def test_webhook_for_an_unknown_item_is_acknowledged(fake: FakePlaid) -> None:
    body = json.dumps(
        {
            "webhook_type": "TRANSACTIONS",
            "webhook_code": "SYNC_UPDATES_AVAILABLE",
            "item_id": "nope",
        }
    ).encode()
    r = new_client().post(
        "/api/webhooks/plaid", content=body, headers={"Plaid-Verification": sign(fake, body)}
    )
    assert r.status_code == 200 and r.json()["outcome"] == "unknown_item"


def _end_plan(user_id: str) -> None:
    from app.models.billing import Subscription
    from app.rules_server.entitlements import store_entitlements

    with get_session_factory()() as db, db.begin():
        for row in db.scalars(
            select(Subscription).where(Subscription.user_id == uuid.UUID(user_id))
        ):
            row.status, row.ends_at = "canceled", datetime.now(UTC) - timedelta(minutes=1)
        db.flush()
        store_entitlements(db, uuid.UUID(user_id))


def test_reading_a_bank_needs_a_plan_that_links(fake: FakePlaid) -> None:
    """October 24, 2026: once Connected ends, connections stay but aren't read."""
    from tests.billing_helpers import grant_plan

    client, user_id, conn_id, access = linked(fake)
    _end_plan(user_id)
    for path, body in (("sync", {"cursor": None}), ("cards", None), ("relink", None)):
        r = client.post(f"/api/linking/{conn_id}/{path}", json=body)
        assert r.status_code == 403 and r.json() == {"detail": "plan_required"}, path
    assert fake.bodies("/transactions/sync") == []  # Plaid was never asked
    assert len(client.get("/api/linking").json()["connections"]) == 1  # kept
    grant_plan(user_id, "connected")  # back on Connected: it reads again
    fake.queue_sync(access, {"added": [PLAID_TXN]})
    assert client.post(f"/api/linking/{conn_id}/sync", json={"cursor": None}).status_code == 200


def test_a_made_up_key_id_is_looked_up_once_and_lookups_are_capped(fake: FakePlaid) -> None:
    hook = new_client()
    body = json.dumps({"webhook_type": "ITEM", "webhook_code": "ERROR", "item_id": "x"}).encode()
    for _ in range(3):
        r = hook.post(
            "/api/webhooks/plaid",
            content=body,
            headers={"Plaid-Verification": sign(fake, body, kid="made-up")},
        )
        assert r.status_code == 400 and r.json()["detail"] == "key_unavailable"
    assert len(fake.bodies("/webhook_verification_key/get")) == 1
    for i in range(20):  # a new made-up id each time: at most 10 lookups a minute
        hook.post(
            "/api/webhooks/plaid",
            content=body,
            headers={"Plaid-Verification": sign(fake, body, kid=f"made-up-{i}")},
        )
    assert len(fake.bodies("/webhook_verification_key/get")) == webhook_verify.LOOKUPS_PER_MINUTE


def test_a_key_plaid_has_retired_verifies_nothing(fake: FakePlaid) -> None:
    fake.key_expired = True
    body = json.dumps({"webhook_type": "ITEM", "webhook_code": "ERROR", "item_id": "x"}).encode()
    r = new_client().post(
        "/api/webhooks/plaid", content=body, headers={"Plaid-Verification": sign(fake, body)}
    )
    assert r.status_code == 400 and r.json()["detail"] == "key_unavailable"
