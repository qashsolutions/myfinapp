"""Someone who is not in a split group can't see it, add to it or change it: every route is 404
(invariant 78 keeps what's inside unreadable; this keeps the group itself out of reach)."""

import base64
import uuid

import pytest

from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def test_non_member_gets_404_everywhere() -> None:
    alice, bob = new_client(), new_client()
    alice_id = sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    grant_plan(alice_id, "private")
    group = alice.post("/api/splits").json()
    gid, member = group["id"], group["my_member_id"]
    bill = alice.post(f"/api/splits/{gid}/bills").json()["id"]
    blob = {"ciphertext": b64(b"\x01opaque"), "version": 1}

    assert bob.get(f"/api/splits/{gid}/state").status_code == 404
    assert bob.post(f"/api/splits/{gid}/bills").status_code == 404
    assert bob.put(f"/api/splits/{gid}/blobs/ledger", json=blob).status_code == 404
    assert bob.put(f"/api/splits/{gid}/blobs/ledger/2026-11", json=blob).status_code == 404
    assert bob.post(f"/api/splits/{gid}/state", json={"known": {}}).status_code == 404
    assert (
        bob.post(f"/api/splits/{gid}/invites", json={"email": "x@example.com"}).status_code == 404
    )
    assert bob.post(f"/api/splits/{gid}/disputes", json={"bill_id": bill}).status_code == 404
    assert bob.post(f"/api/splits/{gid}/disputes/{bill}/close").status_code == 404
    assert bob.post(f"/api/splits/{gid}/leave", json={"report": "pushy"}).status_code == 404
    assert bob.delete(f"/api/splits/{gid}/members/{member}").status_code == 404
    assert bob.post(f"/api/splits/{gid}/takeover").status_code == 404
    notify = {"kind": "paid", "member_id": member}
    assert bob.post(f"/api/splits/{gid}/notify", json=notify).status_code == 404
    key = {"device_key_id": "dev-bob-01", "public_key": b64(b"pub")}
    assert bob.put(f"/api/splits/{gid}/keys/request", json=key).status_code == 404
    wrapped = {"wrapped_key": b64(b"w")}
    assert bob.put(f"/api/splits/{gid}/keys/{member}/dev-x-0001", json=wrapped).status_code == 404
    assert bob.get(f"/api/splits/{uuid.uuid4()}/state").status_code == 404
    assert bob.get("/api/splits").json()["groups"] == []
    # Alice is untouched: one member, one bill, no reports
    assert alice.get(f"/api/splits/{gid}/state").json()["bill_ids"] == [bill]
    assert alice.get("/api/splits").json()["blocked"] is False
