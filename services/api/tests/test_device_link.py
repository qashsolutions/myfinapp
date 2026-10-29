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
from app.routers.device_link import _normalize
from app.security.hashing import token_hash
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
    r = phone.post("/api/auth/link/lookup", json={"code": started["code"]})
    assert r.status_code == 409 and r.json()["detail"] == "already_answered"

    late, started = _computer(net)
    with get_session_factory()() as s:
        row = s.scalars(select(DeviceLink).order_by(DeviceLink.created_at.desc())).first()
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        s.commit()
    r = phone.post("/api/auth/link/lookup", json={"code": started["code"]})
    assert r.status_code == 409 and r.json()["detail"] == "expired"
    assert late.get("/api/auth/link/status").json()["status"] == "expired"

    assert phone.post("/api/auth/link/lookup", json={"code": "ZZZZ-ZZZZ"}).status_code == 404
    assert new_client().get("/api/auth/link/status").status_code == 404  # no cookie


def _status_of(code: str) -> str:
    with get_session_factory()() as s:
        rows = s.scalars(select(DeviceLink)).all()
        (row,) = [r for r in rows if r.code_hash == token_hash(_normalize(code))]
        return row.status


def test_each_request_is_answered_once() -> None:
    """Owner decision, October 28, 2026: a link request is approved or denied once, then
    closed. A second answer, either way, is 409 and changes nothing; so is any answer once the
    request expired."""
    net = _network()
    phone, auth, _ = _phone(net)
    assert_passkey(phone, auth)

    # Denied, then approve and deny again: 409, still denied, no second audit row.
    computer, started = _computer(net)
    code = started["code"]
    assert phone.post("/api/auth/link/deny", json={"code": code}).status_code == 200
    for route in ("approve", "deny"):
        r = phone.post(f"/api/auth/link/{route}", json={"code": code})
        assert r.status_code == 409 and r.json()["detail"] == "already_answered", (route, r.text)
    assert _status_of(code) == "denied"
    assert computer.get("/api/auth/link/status").json()["status"] == "denied"

    # Approved, then deny and approve again: 409, and the computer still signs in once.
    computer, started = _computer(net)
    code = started["code"]
    assert phone.post("/api/auth/link/approve", json={"code": code}).status_code == 200
    for route in ("deny", "approve"):
        r = phone.post(f"/api/auth/link/{route}", json={"code": code})
        assert r.status_code == 409 and r.json()["detail"] == "already_answered", (route, r.text)
    assert _status_of(code) == "approved"
    assert computer.get("/api/auth/link/status").json()["status"] == "approved"
    # Picked up (consumed): still answered.
    r = phone.post("/api/auth/link/deny", json={"code": code})
    assert r.status_code == 409 and r.json()["detail"] == "already_answered"

    # Expired before any answer: 409 expired, and the row is left as it was.
    computer, started = _computer(net)
    code = started["code"]
    with get_session_factory()() as s:
        row = s.scalars(select(DeviceLink).order_by(DeviceLink.created_at.desc())).first()
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        s.commit()
    for route in ("approve", "deny"):
        r = phone.post(f"/api/auth/link/{route}", json={"code": code})
        assert r.status_code == 409 and r.json()["detail"] == "expired", (route, r.text)
    assert _status_of(code) == "pending"
    assert computer.get("/api/auth/link/status").json()["status"] == "expired"
    with get_session_factory()() as s:
        denied = s.scalars(select(AuditLog).where(AuditLog.action == "device_link_denied")).all()
        approved = s.scalars(
            select(AuditLog).where(AuditLog.action == "device_link_approved")
        ).all()
    assert len([a for a in denied if a.actor_id]) >= 1
    assert len({a.target for a in approved}) == len(approved)  # one approval per request
    assert len({a.target for a in denied}) == len(denied)  # one denial per request


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


def _step_up_routes() -> list[tuple[str, str]]:
    """Every operation whose dependencies include `require_step_up`, read from the app itself,
    so a new step-up route is covered without editing this list."""
    from fastapi.routing import APIRoute

    from app.main import create_app
    from app.security.principal import require_step_up

    def needs(dep) -> bool:
        return any(d.call is require_step_up or needs(d) for d in dep.dependencies)

    def routes(items):
        for item in items:
            inner = getattr(item, "original_router", None)  # an included router
            yield from routes(inner.routes) if inner is not None else [item]

    out = []
    for route in routes(create_app().routes):
        if isinstance(route, APIRoute) and needs(route.dependant):
            path = route.path
            for name in route.param_convertors:
                path = path.replace("{" + name + "}", str(uuid.uuid4()))
            out.extend((m, path) for m in route.methods)
    return sorted(out)


def _linked_computer():
    net = _network()
    phone, auth, email = _phone(net)
    computer, started = _computer(net)
    assert_passkey(phone, auth)
    assert phone.post("/api/auth/link/approve", json={"code": started["code"]}).status_code == 200
    r = computer.get("/api/auth/link/status")
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    return computer, auth, email


def test_a_linked_computer_opens_unlocked_with_no_step_up_credit() -> None:
    """Invariant 44 (owner decision, October 29, 2026): the phone's passkey check approves the
    sign-in; it is never a check on the computer. The computer opens unlocked, but every
    step-up route (export, delete, email change, adding a passkey, plan changes, bank
    linking, ...) asks for a passkey check on the computer first, so a phished approval never
    gets five minutes to add its own passkey, change the email or delete the account."""
    computer, auth, _email = _linked_computer()
    me = computer.get("/api/auth/session").json()
    assert me["locked"] is False and me["passkey_verified_at"] is None
    assert computer.get("/api/security/passkeys").status_code == 200  # unlocked

    routes = _step_up_routes()
    assert ("POST", "/api/account/export") in routes and ("POST", "/api/account/delete") in routes
    for method, path in routes:
        r = computer.request(method, path, json={})
        assert r.status_code == 403 and r.json()["detail"] == "step_up_required", (
            method,
            path,
            r.status_code,
            r.text,
        )
    # Adding a passkey checks step-up inline (the first passkey at sign-up needs none).
    for path in (
        "/api/security/passkeys/register/options",
        "/api/security/passkeys/register/verify",
    ):
        r = computer.post(path, json={"credential": {}})
        assert r.status_code == 403 and r.json()["detail"] == "step_up_required", (path, r.text)

    # A passkey check on the computer (the phone's synced passkey, through the browser's
    # "use a phone" option) gives the credit, as on any device.
    assert_passkey(computer, auth, purpose="step_up")
    assert computer.get("/api/auth/session").json()["passkey_verified_at"] is not None
    assert computer.post("/api/security/passkeys/register/options").status_code == 200
    assert computer.post("/api/account/export").status_code == 200


def test_a_linked_computer_locks_when_idle_like_any_session() -> None:
    computer, auth, _ = _linked_computer()
    with get_session_factory()() as s:
        row = s.scalars(select(Session).order_by(Session.created_at.desc())).first()
        assert row is not None
        row.last_seen_at = datetime.now(UTC) - timedelta(hours=2)
        row.link_unlocked_at = datetime.now(UTC) - timedelta(hours=2)
        s.commit()
    assert computer.get("/api/auth/session").json()["locked"] is True
    assert computer.get("/api/security/passkeys").status_code == 403
    assert_passkey(computer, auth)
    assert computer.get("/api/security/passkeys").status_code == 200


def test_assertion_options_leave_the_phone_option_open() -> None:
    """A computer with no passkey of its own steps up with the phone's synced passkey through
    the browser's cross-device (hybrid) option: the options never narrow the passkeys to this
    device's transports and never hint at a platform authenticator."""
    computer, _auth, _ = _linked_computer()
    r = computer.post("/api/security/passkeys/assert/options", json={"purpose": "step_up"})
    assert r.status_code == 200, r.text
    options = r.json()["options"]
    assert options["allowCredentials"], options
    for cred in options["allowCredentials"]:
        assert "transports" not in cred or "hybrid" in cred["transports"], cred
    assert "client-device" not in options.get("hints", [])
    assert options.get("authenticatorAttachment") in (None, "cross-platform")
