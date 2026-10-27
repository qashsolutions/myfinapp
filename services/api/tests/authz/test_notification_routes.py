"""Alert schedules and notification settings are per user: another account never sees them."""

import uuid

import pytest

from tests.auth_flow import new_client, outbox, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_schedule_and_settings_are_private() -> None:
    alice, bob = new_client(), new_client()
    sign_up(alice, f"alice+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    sign_up(bob, f"bob+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    r = alice.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": "2026-10-20T14:00:00Z",
                    "type": "upcoming_expense",
                    "dedupe_key": "bill:1",
                }
            ]
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["registered"] == 1
    assert (
        alice.put("/api/notifications/settings", json={"settings": {"daily_max": 2}}).status_code
        == 200
    )

    assert bob.get("/api/alerts/schedule").json()["items"] == []
    assert bob.get("/api/notifications/settings").json()["settings"]["daily_max"] != 2
    assert [i["dedupe_key"] for i in alice.get("/api/alerts/schedule").json()["items"]] == [
        "bill:1"
    ]
