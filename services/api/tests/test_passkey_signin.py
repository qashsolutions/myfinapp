"""Passkey sign-in with no email code (October 13, 2026): a returning user on a new browser or
device whose passkey synced there signs in and unlocks with one Face ID / Touch ID."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.audit_log import AuditLog
from tests.auth_flow import new_client, outbox, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _email() -> str:
    return f"pk-{uuid.uuid4().hex[:10]}@example.com"


def _sign_in(client, authenticator: FakeAuthenticator, credential_id: bytes | None = None):
    r = client.post("/api/auth/passkey/options")
    assert r.status_code == 200, r.text
    options = r.json()["options"]
    assert options.get("allowCredentials", []) == []  # the device offers what it holds
    assert options["userVerification"] == "required"
    credential = authenticator.assert_(options, credential_id or authenticator.credential_ids[0])
    return credential, client.post("/api/auth/passkey/verify", json={"credential": credential})


def test_a_synced_passkey_signs_in_and_unlocks_on_a_new_device() -> None:
    email, phone = _email(), FakeAuthenticator()
    sign_up(new_client(), email, phone)
    laptop = new_client()
    before = len(outbox())
    _, r = _sign_in(laptop, phone)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["authenticated"] is True and body["locked"] is False
    assert body["user"]["email"] == email
    assert "stackd_session" in r.cookies
    # Unlocked: a route that needs a fresh passkey check works straight away.
    assert laptop.get("/api/security/passkeys").status_code == 200
    # Same alert and audit as an email-code sign-in.
    assert len(outbox()) == before + 1
    with get_session_factory()() as db:
        actions = [a.action for a in db.scalars(select(AuditLog).order_by(AuditLog.created_at))]
    assert actions[-1] == "sign_in"


def test_a_signed_response_cannot_be_replayed() -> None:
    phone = FakeAuthenticator()
    sign_up(new_client(), _email(), phone)
    client = new_client()
    credential, r = _sign_in(client, phone)
    assert r.status_code == 200
    again = new_client().post("/api/auth/passkey/verify", json={"credential": credential})
    assert again.status_code == 400
    assert again.json()["detail"] == "no_challenge"


def test_a_passkey_we_never_registered_is_refused_and_audited() -> None:
    stranger = FakeAuthenticator()
    stranger.register(
        {
            "challenge": "AAAA",
            "rp": {"id": "localhost"},
            "user": {"id": "AAAA", "name": "x", "displayName": "x"},
            "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
        }
    )
    _, r = _sign_in(new_client(), stranger)
    assert r.status_code == 400
    assert r.json()["detail"] == "unknown_credential"
    with get_session_factory()() as db:
        last = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc())).first()
    assert last is not None and last.action == "sign_in_failed" and last.target == "passkey"


def test_a_passkey_used_on_another_website_is_refused() -> None:
    phone = FakeAuthenticator()
    sign_up(new_client(), _email(), phone)
    phishing = FakeAuthenticator(origin="https://evil.example")
    phishing.keys, phishing.counts = phone.keys, phone.counts
    _, r = _sign_in(new_client(), phishing)
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_credential"


def test_cross_site_requests_are_refused() -> None:
    client = new_client()
    r = client.post("/api/auth/passkey/options", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_opening_the_sign_in_screen_does_not_use_up_sign_in_attempts() -> None:
    """October 22, 2026 (found by the first end-to-end run): each visit to the sign-in or Welcome
    back screen fetches a challenge for autofill. Those have their own limit, so a household on one
    IP that opens the app a dozen times can still sign in."""
    email, phone = _email(), FakeAuthenticator()
    sign_up(new_client(), email, phone)
    laptop = new_client()
    for _ in range(15):  # more than the 10 sign-in attempts per 15 minutes
        assert laptop.post("/api/auth/passkey/options").status_code == 200
    _, r = _sign_in(laptop, phone)
    assert r.status_code == 200, r.text
