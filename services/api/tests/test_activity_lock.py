"""Auto-lock counts only what the person does (owner decision, October 28, 2026).

A request the app makes on its own (marked `X-Qash-Background: 1`), a request the browser marks
as coming from another site (`Sec-Fetch-Site` present and not `same-origin`) and a top-level
navigation (`Sec-Fetch-Mode: navigate`) are served as usual but never extend the idle window.
When the app's screen locks, `POST /api/auth/lock` locks this session on the server too, until
the next passkey check.
"""

import uuid

import pytest
from sqlalchemy import text

from app.db import get_session_factory
from tests.auth_flow import assert_passkey, new_client, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated):
    yield


def _email() -> str:
    return f"idle-{uuid.uuid4().hex[:10]}@example.com"


def _age(session_id: str, minutes: float) -> None:
    """Move the session's last activity and passkey check `minutes` further into the past."""
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET last_seen_at = last_seen_at - (:m || ' minutes')::interval, "
                "passkey_verified_at = passkey_verified_at - (:m || ' minutes')::interval "
                "WHERE id = :id"
            ),
            {"m": str(minutes), "id": session_id},
        )


def _locked(client) -> bool:
    return client.get("/api/auth/session").json()["locked"]


NOT_THE_PERSON = [
    {"X-Qash-Background": "1"},
    {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"},
    {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors"},
    {"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate"},
    {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate"},
]


@pytest.mark.parametrize("headers", NOT_THE_PERSON)
def test_requests_the_person_did_not_make_never_keep_the_session_awake(headers) -> None:
    client = new_client()
    info = sign_up(client, _email(), FakeAuthenticator())
    _age(info["session_id"], 4)
    # Served as usual while unlocked...
    for _ in range(3):
        r = client.get("/api/security/devices", headers=headers)
        assert r.status_code == 200, r.text
    # ...but the idle clock kept running: 4 + 2 minutes idle is past the 5-minute lock.
    _age(info["session_id"], 2)
    assert _locked(client) is True
    r = client.get("/api/security/devices", headers=headers)
    assert r.status_code == 403 and r.json() == {"detail": "locked"}


@pytest.mark.parametrize(
    "headers",
    [{}, {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"}, {"X-Qash-Background": "0"}],
)
def test_a_request_the_person_made_keeps_the_session_awake(headers) -> None:
    client = new_client()
    info = sign_up(client, _email(), FakeAuthenticator())
    _age(info["session_id"], 4)
    assert client.get("/api/security/devices", headers=headers).status_code == 200
    _age(info["session_id"], 2)  # 2 minutes since that request
    assert _locked(client) is False


def test_the_screen_lock_locks_the_server_session_until_a_passkey_check() -> None:
    authenticator = FakeAuthenticator()
    client = new_client()
    sign_up(client, _email(), authenticator)
    assert _locked(client) is False
    r = client.post("/api/auth/lock")
    assert r.status_code == 204, r.text
    assert _locked(client) is True
    r = client.get("/api/security/devices")
    assert r.status_code == 403 and r.json() == {"detail": "locked"}
    # Locking again (another tab) is fine and still locked.
    assert client.post("/api/auth/lock").status_code == 204
    assert _locked(client) is True
    assert_passkey(client, authenticator)
    assert _locked(client) is False
    assert client.get("/api/security/devices").status_code == 200


def test_locking_needs_a_session_and_our_own_site() -> None:
    assert new_client().post("/api/auth/lock").status_code == 401
    client = new_client()
    sign_up(client, _email(), FakeAuthenticator())
    r = client.post("/api/auth/lock", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json() == {"detail": "cross_site"}
    assert _locked(client) is False
