"""Backups and households are per user: another account sees nothing of yours."""

import base64
import os
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


def test_backups_and_households_are_private() -> None:
    alice, bob = new_client(), new_client()
    alice_id = sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    bob_id = sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())["user"][
        "id"
    ]
    grant_plan(alice_id, "connected")
    grant_plan(bob_id, "connected")
    key = {
        "key_version": 1,
        "recovery_wrapped": b64(os.urandom(40)),
        "recovery_salt": b64(os.urandom(16)),
    }
    assert alice.put("/api/backup/key", json=key).status_code == 200
    assert (
        alice.put(
            "/api/backup/blob",
            json={
                "ciphertext": b64(os.urandom(50)),
                "key_version": 1,
                "snapshot_at": "2026-10-10T12:00:00Z",
            },
        ).status_code
        == 200
    )

    assert bob.get("/api/backup").json()["enabled"] is False
    assert bob.get("/api/backup/blob/latest").status_code == 404
    assert bob.delete("/api/backup").status_code == 204  # his own (empty) backup, not hers
    assert alice.get("/api/backup/blob/latest").status_code == 200

    alice.post("/api/household/invites")
    assert bob.get("/api/household").json()["household"] is None
    assert bob.get("/api/household/blobs").status_code == 404
    assert (
        bob.put(
            "/api/household/blobs/jars", json={"ciphertext": b64(b"x"), "version": 1}
        ).status_code
        == 404
    )
    assert bob.post("/api/household/leave").status_code == 404
