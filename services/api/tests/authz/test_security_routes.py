"""Another signed-in user can neither see nor remove my passkeys or devices."""

import uuid

import pytest

from tests.auth_flow import assert_passkey, new_client, outbox, register_passkey, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_cross_user_passkeys_and_devices_are_404() -> None:
    alice, bob = new_client(), new_client()
    alice_auth, bob_auth = FakeAuthenticator(), FakeAuthenticator()
    alice_info = sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", alice_auth)
    sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", bob_auth)
    register_passkey(alice, alice_auth, label="second")
    alice_passkeys = alice.get("/api/security/passkeys").json()

    assert_passkey(bob, bob_auth, purpose="step_up")  # Bob is fully verified
    assert bob.get("/api/security/passkeys").json() != alice_passkeys
    for pk in alice_passkeys:
        r = bob.delete(f"/api/security/passkeys/{pk['id']}")
        assert r.status_code == 404, r.text
    r = bob.delete(f"/api/security/devices/{alice_info['session_id']}")
    assert r.status_code == 404
    assert [d["current"] for d in bob.get("/api/security/devices").json()] == [True]
    # Alice is untouched
    assert len(alice.get("/api/security/passkeys").json()) == 2
    assert alice.get("/api/auth/session").json()["authenticated"] is True
