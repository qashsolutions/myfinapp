"""Revoke + alerts (chunk 3.4): Disconnect never gets stuck, deletion and 60 days of dormancy
revoke at the provider, failures are retried, and "sign in again" repairs a connection."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs.link_revoke import revoke_due
from app.linking import plaid
from app.models.audit_log import AuditLog
from app.models.linking import BankConnection
from app.models.user import User
from app.services.deletion import purge_due
from tests.auth_flow import outbox
from tests.plaid_fake import FakePlaid
from tests.test_linking import member, start


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    plaid.transport_override = None
    yield
    plaid.transport_override = None


@pytest.fixture
def fake() -> FakePlaid:
    f = FakePlaid()
    plaid.transport_override = f.transport()
    return f


def linked(fake: FakePlaid, name: str = "maya"):
    client, user_id = member(name)
    session_id = start(client, fake, "First Platypus Bank")
    conn_id = client.post("/api/linking/finish", json={"session_id": session_id}).json()[
        "connections"
    ][0]["id"]
    return client, user_id, conn_id, fake.access_tokens()[-1]


def row(conn_id: str) -> BankConnection | None:
    with get_session_factory()() as db:
        return db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))


def age(conn_id: str, days: int) -> None:
    with get_session_factory()() as db:
        r = db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))
        assert r is not None
        r.last_used_at = datetime.now(UTC) - timedelta(days=days)
        db.commit()


def run_job(now: datetime | None = None) -> dict[str, int]:
    with get_session_factory()() as db:
        return revoke_due(db, now=now)


# The job runs over every connection in the database, including rows other tests left behind
# (their own fakes, their own failures), so its counts are only lower bounds for one test:
# what each test checks is its own connection's row and token.
def still_linked(conn_id: str, access: str, fake: FakePlaid) -> bool:
    return row(conn_id) is not None and access not in fake.removed


def revoked(conn_id: str, access: str, fake: FakePlaid) -> bool:
    return row(conn_id) is None and access in fake.removed


def test_disconnect_while_the_provider_is_down_still_disconnects_and_is_retried(
    fake: FakePlaid,
) -> None:
    client, _, conn_id, access = linked(fake)
    fake.fail_remove = True
    assert client.delete(f"/api/linking/{conn_id}").status_code == 204
    assert client.get("/api/linking").json()["connections"] == []  # gone for the user at once
    assert client.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 404
    pending = row(conn_id)
    assert pending is not None and pending.status == "revoke_pending"
    assert run_job()["failed"] >= 1  # still down: kept for the next run
    pending = row(conn_id)
    assert pending is not None and pending.status == "revoke_pending"
    assert access not in fake.removed
    fake.fail_remove = False
    assert run_job()["pending_revoked"] >= 1
    assert revoked(conn_id, access, fake)


def test_pending_rows_do_not_count_against_the_plan(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    fake.fail_remove = True
    client.delete(f"/api/linking/{conn_id}")
    for name in ("Second Bank", "Third Bank", "Fourth Bank"):
        session_id = start(client, fake, name)
        r = client.post("/api/linking/finish", json={"session_id": session_id})
        assert r.status_code == 200, r.text
    assert len(client.get("/api/linking").json()["connections"]) == 3


def test_sixty_days_without_opening_the_app_revokes_and_tells_the_owner(fake: FakePlaid) -> None:
    client, user_id, conn_id, access = linked(fake)
    email = client.get("/api/auth/session").json()["user"]["email"]
    age(conn_id, 59)
    run_job()
    assert still_linked(conn_id, access, fake)
    # Reading the list changes nothing (a cross-site GET carries the cookie too, October 28,
    # 2026); opening the app pulls (LinkedSync's POST .../sync), and that counts as use.
    age(conn_id, 61)
    assert client.get("/api/linking").status_code == 200
    assert row(conn_id).last_used_at < datetime.now(UTC) - timedelta(days=60)
    assert client.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 200
    run_job()
    assert still_linked(conn_id, access, fake)
    # Even when the bank wants the person to sign in again, opening the app counted.
    age(conn_id, 61)
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    assert client.post(f"/api/linking/{conn_id}/sync", json={}).status_code == 409
    fake.sync_error = None
    run_job()
    assert still_linked(conn_id, access, fake)
    age(conn_id, 61)
    outbox().clear()
    assert run_job()["dormant_revoked"] >= 1
    assert revoked(conn_id, access, fake)
    [mail] = [m for m in outbox() if m.to == email and "turned off a bank connection" in m.subject]
    assert "60 days" in mail.text and "stay on your device" in mail.text
    assert "If this was you" not in mail.text
    with get_session_factory()() as db:
        actions = db.scalars(
            select(AuditLog.action).where(AuditLog.actor_id == uuid.UUID(user_id))
        ).all()
    assert "bank_auto_revoked" in actions


def test_deletion_never_drops_a_live_token(fake: FakePlaid) -> None:
    client, user_id, conn_id, access = linked(fake)
    fake.fail_remove = True
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code in (200, 204)
    pending = row(conn_id)
    assert pending is not None and pending.status == "revoke_pending"
    far = datetime.now(UTC) + timedelta(days=400)
    # Other tests' deleted accounts may be purged too; what matters is this one.
    with get_session_factory()() as db:
        purge_due(db, grace_days=30, now=far)
        db.commit()
    with get_session_factory()() as db:
        assert db.get(User, uuid.UUID(user_id)) is not None  # held back: the token is live
    fake.fail_remove = False
    with get_session_factory()() as db:
        purge_due(db, grace_days=30, now=far)
        db.commit()
    with get_session_factory()() as db:
        assert db.get(User, uuid.UUID(user_id)) is None
    assert row(conn_id) is None and access in fake.removed


def test_sign_in_again_uses_update_mode_and_repairs_the_connection(fake: FakePlaid) -> None:
    client, _, conn_id, access = linked(fake)
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    client.post(f"/api/linking/{conn_id}/sync", json={})
    assert client.get("/api/linking").json()["connections"][0]["status"] == "login_required"

    r = client.post(f"/api/linking/{conn_id}/relink", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 200, r.text
    create = fake.bodies("/link/token/create")[-1]
    assert create["access_token"] == access  # update mode: same item, no new products
    assert "products" not in create
    fake.sync_error = None
    done = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert done.status_code == 200 and done.json()["status"] == "linked"
    assert done.json()["connections"][0]["id"] == conn_id
    assert client.get("/api/linking").json()["connections"][0]["status"] == "ok"
    assert len(fake.access_tokens()) == 1  # no second item was made


def test_someone_else_cannot_relink_your_connection(fake: FakePlaid) -> None:
    _, _, conn_id, _ = linked(fake, "maya")
    other, _ = member("sam")
    assert other.post(f"/api/linking/{conn_id}/relink").status_code == 404
