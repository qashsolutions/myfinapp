"""Sign-in & security shows every device with its status, and the last 30 days of sign-ins,
failed attempts and security changes (October 13, 2026). No IP addresses are returned."""

import uuid

import pytest
from sqlalchemy import text

from app.db import get_session_factory
from tests.auth_flow import (
    MAC_UA,
    assert_passkey,
    new_client,
    send_code,
    sign_in_with_code,
    sign_up,
)
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated):
    yield


def _email() -> str:
    return f"activity-{uuid.uuid4().hex[:10]}@example.com"


def test_devices_show_status_and_ended_sessions_for_thirty_days() -> None:
    email, auth = _email(), FakeAuthenticator()
    phone = new_client()
    sign_up(phone, email, auth)
    laptop = new_client(user_agent=MAC_UA)
    sign_in_with_code(laptop, email)
    assert_passkey(laptop, auth)
    tablet = new_client(user_agent=MAC_UA)
    sign_in_with_code(tablet, email)
    assert_passkey(tablet, auth)

    # The laptop signs itself out; the phone signs the tablet out.
    laptop.post("/api/auth/signout")
    tablet_id = tablet.get("/api/auth/session").json()["session_id"]
    assert phone.delete(f"/api/security/devices/{tablet_id}").status_code == 204

    devices = phone.get("/api/security/devices").json()
    by_status = {d["status"]: d for d in devices}
    assert devices[0]["status"] == "current" and devices[0]["current"] is True
    assert by_status["signed_out"]["ended_at"] is not None
    assert by_status["signed_out_remote"]["id"] == tablet_id
    assert all("ip" not in k for d in devices for k in d)

    # A session that ended more than 30 days ago drops off the list.
    with get_session_factory()() as db, db.begin():
        db.execute(
            text("UPDATE sessions SET revoked_at = now() - interval '31 days' WHERE id = :id"),
            {"id": tablet_id},
        )
    assert tablet_id not in [d["id"] for d in phone.get("/api/security/devices").json()]


def test_activity_lists_sign_ins_failures_and_changes_newest_first() -> None:
    email, auth = _email(), FakeAuthenticator()
    me = new_client()
    sign_up(me, email, auth)
    stranger = new_client()
    send_code(stranger, email)
    r = stranger.post("/api/auth/otp/verify", json={"email": email, "code": "000000"})
    assert r.status_code == 400
    assert me.put("/api/security/lock", json={"minutes": 20}).status_code == 200

    items = me.get("/api/security/activity").json()
    kinds = [i["kind"] for i in items]
    assert kinds[0] == "lock_changed"  # newest first
    assert "sign_in_failed" in kinds and "sign_in" in kinds and "passkey_added" in kinds
    sign_in = next(i for i in items if i["kind"] == "sign_in")
    assert sign_in["device_label"]  # the device that signed in is named
    assert all(set(i) == {"at", "kind", "device_label"} for i in items)  # no IP, no target


def test_someone_elses_activity_is_never_shown() -> None:
    a, b = new_client(), new_client()
    sign_up(a, _email(), FakeAuthenticator())
    email_b = _email()
    sign_up(b, email_b, FakeAuthenticator())
    b.put("/api/security/lock", json={"minutes": 30})
    mine = [i["kind"] for i in a.get("/api/security/activity").json()]
    assert "lock_changed" not in mine
    assert a.get("/api/security/devices").json()[0]["current"] is True
    assert len(a.get("/api/security/devices").json()) == 1
