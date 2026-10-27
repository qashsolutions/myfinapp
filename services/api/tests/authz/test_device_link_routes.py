"""Link with your phone: a code someone else already approved can't be approved or seen again,
and nobody picks up a computer's session without that computer's own cookie."""

import uuid

import pytest

from tests.auth_flow import MAC_UA, assert_passkey, new_client, outbox, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_cross_user_device_link() -> None:
    alice, bob = new_client(), new_client()
    alice_auth, bob_auth = FakeAuthenticator(), FakeAuthenticator()
    sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", alice_auth)
    sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", bob_auth)
    computer = new_client(MAC_UA)
    code = computer.post("/api/auth/link/start").json()["code"]
    assert_passkey(alice, alice_auth)
    r = alice.post("/api/auth/link/approve", json={"code": code, "confirm_different_network": True})
    assert r.status_code == 200
    # Bob, holding the code, can neither look it up nor approve it now
    assert bob.post("/api/auth/link/lookup", json={"code": code}).status_code == 404
    assert_passkey(bob, bob_auth)
    r = bob.post("/api/auth/link/approve", json={"code": code, "confirm_different_network": True})
    assert r.status_code == 404
    # Bob's browser has no link cookie: nothing to pick up
    assert bob.get("/api/auth/link/status").status_code == 404
    # The computer itself gets Alice's session
    assert (
        computer.get("/api/auth/link/status")
        .json()["session"]["user"]["email"]
        .startswith("alice+")
    )
