"""Someone who is not in a group cannot see it, post to it or change it: every route is 404."""

import uuid

import pytest

from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_non_member_gets_404_everywhere() -> None:
    alice, bob = new_client(), new_client()
    alice_id = sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    grant_plan(alice_id, "private")
    gid = alice.post("/api/groups", json={"name": "Mine", "month": "2026-10"}).json()["id"]

    assert bob.get(f"/api/groups/{gid}").status_code == 404
    assert bob.put(f"/api/groups/{gid}/progress", json={"progress_bps": 100}).status_code == 404
    assert bob.post(f"/api/groups/{gid}/leave").status_code == 404
    assert bob.delete(f"/api/groups/{gid}/members/{alice_id}").status_code == 404
    assert bob.post(f"/api/groups/{gid}/code").status_code == 404
    assert bob.get(f"/api/groups/{uuid.uuid4()}").status_code == 404
    assert bob.get("/api/groups").json() == []
    # Alice is untouched
    assert alice.get(f"/api/groups/{gid}").json()["member_count"] == 1
