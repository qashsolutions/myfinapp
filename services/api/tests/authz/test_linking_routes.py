"""Connections and link sessions are per user: another account can neither see, finish, sync
nor disconnect yours."""

import uuid

import pytest

from app.linking import plaid
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.plaid_fake import FakePlaid
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    fake = FakePlaid()
    plaid.transport_override = fake.transport()
    yield fake
    plaid.transport_override = None


def test_connections_are_private(_infra: FakePlaid) -> None:
    alice, bob = new_client(), new_client()
    for client, name in ((alice, "alice"), (bob, "bob")):
        user = sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
        grant_plan(user["user"]["id"], "connected")
    r = alice.post("/api/linking/start", headers={"Origin": "http://localhost:5173"})
    session_id = r.json()["session_id"]
    _infra.link(r.json()["url"].rsplit("/", 1)[-1], "First Platypus Bank")

    assert bob.post("/api/linking/finish", json={"session_id": session_id}).status_code == 404
    [conn] = alice.post("/api/linking/finish", json={"session_id": session_id}).json()[
        "connections"
    ]
    assert bob.get("/api/linking").json()["connections"] == []
    assert bob.delete(f"/api/linking/{conn['id']}").status_code == 404
    assert bob.post(f"/api/linking/{conn['id']}/sync", json={}).status_code == 404
    assert bob.post(f"/api/linking/{conn['id']}/cards").status_code == 404
    assert _infra.bodies("/transactions/sync") == []
    assert _infra.bodies("/liabilities/get") == []
    assert _infra.removed == []
    assert len(alice.get("/api/linking").json()["connections"]) == 1
