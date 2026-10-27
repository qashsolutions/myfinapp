"""Encrypted backup: the server stores wrapped keys and ciphertext it cannot read, keeps the
newest three, lists the devices that sync, and wipes everything when backup goes off or the
account is deleted. The PRF salt rides on the passkey assertion options."""

import base64
import os
import uuid

import pytest
from sqlalchemy import text

from app.db import get_session_factory
from app.models.backup import Backup, BackupKey
from app.routers import backup as backup_router
from app.services import backup_store
from tests.auth_flow import MAC_UA, assert_passkey, new_client, outbox, sign_in_with_code, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


KEY = {
    "key_version": 1,
    "recovery_wrapped": b64(os.urandom(60)),
    "recovery_salt": b64(os.urandom(16)),
    "passkey_wrapped": None,
    "passkey_salt": None,
    "passkey_credential_id": None,
}


def member(name: str, plan: str | None):
    client = new_client()
    email = f"{name}+{uuid.uuid4().hex[:6]}@example.com"
    auth = FakeAuthenticator()
    sign_up(client, email, auth)
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    if plan:
        grant_plan(user_id, plan)
    return client, user_id, email, auth


def test_backup_round_trip_devices_and_pruning(monkeypatch) -> None:
    phone, user_id, email, auth = member("maya", "private")
    r = phone.get("/api/backup")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "enabled": False,
        "available": True,
        "key": None,
        "latest": None,
        "devices": [],
    }

    # No key yet: a blob is refused
    r = phone.put(
        "/api/backup/blob",
        json={
            "ciphertext": b64(b"x" * 32),
            "key_version": 1,
            "snapshot_at": "2026-10-10T12:00:00Z",
        },
    )
    assert r.status_code == 409 and r.json()["detail"] == "no_key"

    r = phone.put("/api/backup/key", json=KEY)
    assert r.status_code == 200, r.text
    assert r.json()["recovery_wrapped"] == KEY["recovery_wrapped"]
    status = phone.get("/api/backup").json()
    assert status["enabled"] is True and status["key"]["key_version"] == 1

    blob = os.urandom(5000)
    r = phone.put(
        "/api/backup/blob",
        json={"ciphertext": b64(blob), "key_version": 1, "snapshot_at": "2026-10-10T12:00:00Z"},
    )
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["size"] == 5000 and first["device_label"].startswith("Safari on iPhone")
    r = phone.put(
        "/api/backup/blob",
        json={"ciphertext": b64(blob), "key_version": 2, "snapshot_at": "2026-10-10T12:00:00Z"},
    )
    assert r.status_code == 409 and r.json()["detail"] == "key_version_mismatch"
    assert (
        phone.put(
            "/api/backup/blob",
            json={"ciphertext": "***", "key_version": 1, "snapshot_at": "2026-10-10T12:00:00Z"},
        ).status_code
        == 422
    )

    # A second device of the same account: the same user, a Mac session
    mac = new_client(MAC_UA)
    sign_in_with_code(mac, email)
    assert_passkey(mac, auth)
    r = mac.get("/api/backup/blob/latest")
    assert r.status_code == 200, r.text
    assert r.json()["ciphertext"] == b64(blob) and r.json()["id"] == first["id"]
    status = mac.get("/api/backup").json()
    assert [d["label"].split(" ·")[0] for d in status["devices"]] == ["Safari on iPhone"]

    # Each device's uploads are listed; only the newest three backups are kept, in storage too
    for i in range(3):
        r = mac.put(
            "/api/backup/blob",
            json={
                "ciphertext": b64(os.urandom(100 + i)),
                "key_version": 1,
                "snapshot_at": "2026-10-10T13:00:00Z",
            },
        )
        assert r.status_code == 200, r.text
    status = mac.get("/api/backup").json()
    assert status["latest"]["size"] == 102
    # The iPhone's only backup was pruned, so the Mac is the one device still listed
    assert [d["label"] for d in status["devices"]] == ["Chrome on Mac"]
    with get_session_factory()() as s:
        rows = s.query(Backup).filter(Backup.user_id == uuid.UUID(user_id)).all()
        assert len(rows) == 3
        assert first["id"] not in {str(r.id) for r in rows}
    assert len(backup_store.list_blob_keys(uuid.UUID(user_id))) == 3

    # Too large is refused before anything is stored
    monkeypatch.setattr(backup_router, "MAX_BLOB_BYTES", 10)
    r = mac.put(
        "/api/backup/blob",
        json={
            "ciphertext": b64(b"y" * 11),
            "key_version": 1,
            "snapshot_at": "2026-10-10T13:00:00Z",
        },
    )
    assert r.status_code == 413 and r.json()["detail"] == "too_large"
    monkeypatch.undo()

    # Backup off: the key record and every blob go
    assert mac.delete("/api/backup").status_code == 204
    assert mac.get("/api/backup").json()["enabled"] is False
    assert mac.get("/api/backup/blob/latest").status_code == 404
    assert backup_store.list_blob_keys(uuid.UUID(user_id)) == []
    with get_session_factory()() as s:
        assert s.query(BackupKey).filter(BackupKey.user_id == uuid.UUID(user_id)).count() == 0


def test_backup_needs_a_paid_plan() -> None:
    client, _, _, _ = member("free", None)
    assert client.get("/api/backup").json()["available"] is False
    r = client.put("/api/backup/key", json=KEY)
    assert r.status_code == 403 and r.json()["detail"] == "plan_required"


def test_deleting_the_account_wipes_the_backup() -> None:
    client, user_id, _, _ = member("maya", "private")
    assert client.put("/api/backup/key", json=KEY).status_code == 200
    assert (
        client.put(
            "/api/backup/blob",
            json={
                "ciphertext": b64(os.urandom(64)),
                "key_version": 1,
                "snapshot_at": "2026-10-10T12:00:00Z",
            },
        ).status_code
        == 200
    )
    assert len(backup_store.list_blob_keys(uuid.UUID(user_id))) == 1
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert backup_store.list_blob_keys(uuid.UUID(user_id)) == []
    with get_session_factory()() as s:
        assert s.query(Backup).filter(Backup.user_id == uuid.UUID(user_id)).count() == 0
        assert s.query(BackupKey).filter(BackupKey.user_id == uuid.UUID(user_id)).count() == 0


def test_assertion_options_carry_the_prf_salt() -> None:
    client, _, _, _ = member("maya", None)
    salt = b64(os.urandom(32))
    r = client.post(
        "/api/security/passkeys/assert/options", json={"purpose": "step_up", "prf_salt": salt}
    )
    assert r.status_code == 200, r.text
    assert r.json()["options"]["extensions"] == {"prf": {"eval": {"first": salt}}}
    r = client.post("/api/security/passkeys/assert/options", json={"purpose": "step_up"})
    assert "extensions" not in r.json()["options"]
    r = client.post(
        "/api/security/passkeys/assert/options",
        json={"purpose": "step_up", "prf_salt": b64(b"short")},
    )
    assert r.status_code == 422


def _stale_step_up(session_id: str) -> None:
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": session_id},
        )


def test_replacing_the_key_or_turning_off_needs_step_up_and_is_alerted() -> None:
    """An unlocked cookie alone must not swap the key copies or wipe every backup (October 24)."""
    client, _, email, auth = member("ravi", "private")
    session_id = client.get("/api/auth/session").json()["session_id"]
    assert client.put("/api/backup/key", json=KEY).status_code == 200
    outbox().clear()

    _stale_step_up(session_id)
    r = client.put("/api/backup/key", json=KEY)
    assert r.status_code == 403 and r.json() == {"detail": "step_up_required"}
    r = client.delete("/api/backup")
    assert r.status_code == 403 and r.json() == {"detail": "step_up_required"}
    assert client.get("/api/backup").json()["enabled"] is True
    assert outbox() == []

    assert_passkey(client, auth, purpose="step_up")
    assert client.put("/api/backup/key", json=KEY).status_code == 200
    assert outbox()[-1].to == email
    assert outbox()[-1].subject == "Your backup was set up again"
    assert client.delete("/api/backup").status_code == 204
    assert outbox()[-1].subject == "Encrypted backup was turned off"
    assert client.get("/api/backup").json()["enabled"] is False


def _upload(client, data: bytes) -> str:
    body = {"ciphertext": b64(data), "key_version": 1, "snapshot_at": "2026-10-24T12:00:00Z"}
    r = client.put("/api/backup/blob", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_a_burst_of_bad_uploads_cannot_push_out_yesterdays_backup() -> None:
    """Newest 3 plus each earlier day's newest (7 days) are kept, and `before` steps back."""
    client, user_id, _, _ = member("lena", "private")
    assert client.put("/api/backup/key", json=KEY).status_code == 200
    good = os.urandom(64)
    good_id = _upload(client, good)
    older_same_day = _upload(client, os.urandom(64))
    with get_session_factory()() as db, db.begin():
        db.execute(
            text("UPDATE backups SET created_at = now() - interval '1 day' WHERE id = :id"),
            {"id": older_same_day},
        )
        db.execute(
            text(
                "UPDATE backups SET created_at = now() - interval '1 day' + interval '1 minute' "
                "WHERE id = :id"
            ),
            {"id": good_id},
        )
        db.execute(
            text("UPDATE backups SET created_at = now() - interval '9 days' WHERE id = :id"),
            {"id": _upload(client, os.urandom(64))},
        )
    junk = [_upload(client, os.urandom(64)) for _ in range(5)]

    with get_session_factory()() as db:
        ids = [str(r.id) for r in backup_store.backups_for(db, uuid.UUID(user_id))]
    # The newest 3 junk copies plus yesterday's newest; the older same-day copy, the
    # 9-day-old one and the two oldest junk copies are gone.
    assert ids == [*reversed(junk[2:]), good_id]

    latest = client.get("/api/backup/blob/latest").json()
    assert latest["id"] == junk[-1]
    step = latest["id"]
    for expected in [junk[3], junk[2], good_id]:
        got = client.get("/api/backup/blob/latest", params={"before": step}).json()
        assert got["id"] == expected
        step = got["id"]
    assert base64.urlsafe_b64decode(got["ciphertext"] + "==") == good
    r = client.get("/api/backup/blob/latest", params={"before": good_id})
    assert r.status_code == 404 and r.json()["detail"] == "no_backup"
