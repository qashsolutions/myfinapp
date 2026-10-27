"""Auto-lock after 5 to 60 idle minutes, the user's choice (owner decision, October 12, 2026).
The server enforces the same window as the app, and a longer lock needs a fresh passkey."""

import uuid

import pytest
from sqlalchemy import select, text

from app.db import get_session_factory
from app.models.audit_log import AuditLog
from tests.auth_flow import assert_passkey, new_client, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated):
    yield


def _email() -> str:
    return f"lock-{uuid.uuid4().hex[:10]}@example.com"


def _age(session_id: str, *, idle: float, passkey: float) -> None:
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET last_seen_at = now() - (:i || ' minutes')::interval, "
                "passkey_verified_at = now() - (:p || ' minutes')::interval WHERE id = :id"
            ),
            {"i": str(idle), "p": str(passkey), "id": session_id},
        )


def test_default_is_five_minutes_and_the_choice_is_enforced_by_the_server() -> None:
    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, _email(), authenticator)
    assert info["lock_after_seconds"] == 300

    r = client.put("/api/security/lock", json={"minutes": 30})
    assert r.status_code == 200 and r.json() == {"minutes": 30}
    assert client.get("/api/auth/session").json()["lock_after_seconds"] == 1800

    _age(info["session_id"], idle=20, passkey=20)
    assert client.get("/api/auth/session").json()["locked"] is False  # 20 < 30
    assert client.get("/api/security/devices").status_code == 200
    _age(info["session_id"], idle=31, passkey=31)
    assert client.get("/api/auth/session").json()["locked"] is True
    assert client.get("/api/security/devices").status_code == 403


def test_changing_it_needs_a_fresh_passkey_and_is_audited() -> None:
    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, _email(), authenticator)
    _age(info["session_id"], idle=0, passkey=6)  # unlocked, but the passkey check is stale
    r = client.put("/api/security/lock", json={"minutes": 60})
    assert r.status_code == 403, r.text
    assert_passkey(client, authenticator, purpose="step_up")
    assert client.put("/api/security/lock", json={"minutes": 60}).json() == {"minutes": 60}
    with get_session_factory()() as db:
        actions = db.scalars(
            select(AuditLog.action).where(AuditLog.actor_id == uuid.UUID(info["user"]["id"]))
        ).all()
    assert "lock_changed" in actions


@pytest.mark.parametrize("minutes", [4, 61, 0, -5])
def test_only_whole_minutes_from_5_to_60(minutes: int) -> None:
    client = new_client()
    sign_up(client, _email(), FakeAuthenticator())
    assert client.put("/api/security/lock", json={"minutes": minutes}).status_code == 422
    assert client.put("/api/security/lock", json={"minutes": 12.5}).status_code == 422
