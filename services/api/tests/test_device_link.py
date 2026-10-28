"""Link with your phone (owner decisions, October 19, 2026): a computer shows a code, a signed-in
phone approves it after a fresh passkey check, the computer picks up a session once. A different
network warns and needs the person's confirmation; at most 3 requests an hour per IP."""

import random
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.audit_log import AuditLog
from app.models.device_link import DeviceLink
from app.models.session import Session
from tests.auth_flow import MAC_UA, assert_passkey, new_client, outbox, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def _network() -> str:
    return f"198.{random.randint(18, 19)}.{random.randint(0, 255)}"


def _phone(network: str | None = None):
    phone, auth = new_client(), FakeAuthenticator()
    if network:
        phone.headers["x-forwarded-for"] = f"{network}.10"
    email = f"maya+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(phone, email, auth)
    return phone, auth, email


def _computer(network: str | None = None):
    computer = new_client(MAC_UA)
    if network:
        computer.headers["x-forwarded-for"] = f"{network}.20"
    r = computer.post("/api/auth/link/start")
    assert r.status_code == 200, r.text
    assert "stackd_link" in r.cookies
    return computer, r.json()


def test_phone_approves_and_the_computer_signs_in_once() -> None:
    net = _network()
    phone, auth, email = _phone(net)
    computer, started = _computer(net)
    code = started["code"]
    assert len(code) == 9 and code[4] == "-" and started["expires_in_seconds"] == 120
    assert computer.get("/api/auth/link/status").json() == {"status": "pending", "session": None}

    looked = phone.post("/api/auth/link/lookup", json={"code": code.lower().replace("-", " ")})
    assert looked.status_code == 200, looked.text
    assert looked.json()["device_label"] == "Chrome on Mac"
    assert looked.json()["same_network"] is True

    assert_passkey(phone, auth)
    r = phone.post("/api/auth/link/approve", json={"code": code})
    assert r.status_code == 200, r.text

    r = computer.get("/api/auth/link/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "approved"
    assert body["session"]["user"]["email"] == email
    assert body["session"]["locked"] is False
    assert "stackd_session" in r.cookies
    me = computer.get("/api/auth/session").json()
    assert me["authenticated"] is True and me["device_label"] == "Chrome on Mac"
    # Once: the same browser can't pick up a second session
    assert computer.get("/api/auth/link/status").status_code == 404
    assert any("Your phone approved a sign-in on Chrome on Mac" in m.text for m in outbox())
    with get_session_factory()() as s:
        actions = {
            a.action for a in s.scalars(select(AuditLog).where(AuditLog.actor_id.is_not(None)))
        }
        assert "device_link_approved" in actions
        row = s.scalars(select(DeviceLink).order_by(DeviceLink.created_at.desc())).first()
        assert row is not None and row.status == "consumed" and row.session_id is not None
        assert code.replace("-", "") not in (row.code_hash, row.secret_hash)  # only hashes


def test_a_different_network_warns_and_needs_confirmation() -> None:
    phone, auth, _ = _phone()
    # A network new_client() never picks (it uses 203.0.x.x), so the two can't share a /24.
    computer, started = _computer("198.51.100")
    assert (
        phone.post("/api/auth/link/lookup", json={"code": started["code"]}).json()["same_network"]
        is False
    )
    assert_passkey(phone, auth)
    r = phone.post("/api/auth/link/approve", json={"code": started["code"]})
    assert r.status_code == 409 and r.json()["detail"] == "different_network"
    assert computer.get("/api/auth/link/status").json()["status"] == "pending"
    r = phone.post(
        "/api/auth/link/approve",
        json={"code": started["code"], "confirm_different_network": True},
    )
    assert r.status_code == 200
    assert computer.get("/api/auth/link/status").json()["status"] == "approved"


def test_approving_needs_a_fresh_passkey_check() -> None:
    net = _network()
    phone, _auth, email = _phone(net)
    _computer_client, started = _computer(net)
    with get_session_factory()() as s:
        for row in s.scalars(select(Session)):
            if row.passkey_verified_at:
                row.passkey_verified_at = datetime.now(UTC) - timedelta(minutes=10)
                row.last_seen_at = datetime.now(UTC)
        s.commit()
    r = phone.post("/api/auth/link/approve", json={"code": started["code"]})
    assert r.status_code == 403, r.text
    assert email


def test_deny_expiry_and_unknown_codes() -> None:
    net = _network()
    phone, _auth, _ = _phone(net)
    computer, started = _computer(net)
    assert phone.post("/api/auth/link/deny", json={"code": started["code"]}).status_code == 200
    assert computer.get("/api/auth/link/status").json()["status"] == "denied"
    assert phone.post("/api/auth/link/lookup", json={"code": started["code"]}).status_code == 404

    late, started = _computer(net)
    with get_session_factory()() as s:
        row = s.scalars(select(DeviceLink).order_by(DeviceLink.created_at.desc())).first()
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        s.commit()
    assert phone.post("/api/auth/link/lookup", json={"code": started["code"]}).status_code == 404
    assert late.get("/api/auth/link/status").json()["status"] == "expired"

    assert phone.post("/api/auth/link/lookup", json={"code": "ZZZZ-ZZZZ"}).status_code == 404
    assert new_client().get("/api/auth/link/status").status_code == 404  # no cookie


def test_denying_counts_ten_a_day_per_signed_in_device() -> None:
    """Like approving (rate_limit "device_link_approve"), a deny writes an audit row; a
    scripted session can't fill the log or walk codes through it (October 28, 2026)."""
    phone, _auth, _ = _phone()
    codes = [
        phone.post("/api/auth/link/deny", json={"code": "ZZZZ-ZZZZ"}).status_code for _ in range(11)
    ]
    assert codes == [404] * 10 + [429]


def test_three_link_requests_an_hour_per_ip() -> None:
    computer = new_client(MAC_UA)
    for _ in range(3):
        assert computer.post("/api/auth/link/start").status_code == 200
    r = computer.post("/api/auth/link/start")
    assert r.status_code == 429 and "retry-after" in r.headers
