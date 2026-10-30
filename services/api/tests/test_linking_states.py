"""Invariant 72 (October 29, 2026): a connection being removed stays removed until it is revoked.

Before, a bank disconnected while Plaid was down (`revoke_pending`, hidden from the person and
retried by `stackd-api revoke-links`) came back: the webhook's login-required, revoked and
repaired branches set the status without looking at it, so the next ITEM webhook put the row
back in the list and in `bank_links_max`, and the job, which retries only `revoke_pending`,
never revoked its token at Plaid.

The table below is the state machine, worked out by hand: from each status, each thing that can
happen → the status after. `revoke_pending` is terminal for everything but a revoke that
succeeds, which deletes the row (the token revoked at Plaid)."""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs.link_revoke import revoke_due
from app.linking import plaid, webhook_verify
from app.models.linking import BankConnection
from tests.auth_flow import new_client, outbox
from tests.plaid_fake import FakePlaid
from tests.test_linking_sync import linked, sign

STATUSES = ("ok", "login_required", "revoked", "revoke_pending")
GONE = "deleted"  # the row is gone and its token revoked at Plaid


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    plaid.transport_override = None
    webhook_verify.reset()
    yield
    plaid.transport_override = None
    webhook_verify.reset()


@pytest.fixture
def fake() -> FakePlaid:
    f = FakePlaid()
    plaid.transport_override = f.transport()
    return f


def _row(conn_id: str) -> BankConnection | None:
    with get_session_factory()() as db:
        return db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))


def _set(conn_id: str, value: str) -> None:
    with get_session_factory()() as db:
        row = db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))
        assert row is not None
        row.status = value
        db.commit()


def _status(conn_id: str) -> str:
    row = _row(conn_id)
    return GONE if row is None else row.status


def _hook(fake: FakePlaid, conn_id: str, kind: str, code: str, error: str | None = None) -> None:
    row = _row(conn_id)
    assert row is not None
    payload: dict = {"webhook_type": kind, "webhook_code": code, "item_id": row.item_id}
    if error:
        payload["error"] = {"error_code": error}
    body = json.dumps(payload).encode()
    r = new_client().post(
        "/api/webhooks/plaid", content=body, headers={"Plaid-Verification": sign(fake, body)}
    )
    assert r.status_code == 200, r.text


# event → (how to make it happen, {status before: status after}). A revoke_pending connection is
# already gone for the person: their routes answer 404 and change nothing.
WEBHOOKS = {
    "updates_available": ("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", None),
    "item_error_login": ("ITEM", "ERROR", "ITEM_LOGIN_REQUIRED"),
    "item_error_other": ("ITEM", "ERROR", "INTERNAL_SERVER_ERROR"),
    "pending_expiration": ("ITEM", "PENDING_EXPIRATION", None),
    "pending_disconnect": ("ITEM", "PENDING_DISCONNECT", None),
    "user_permission_revoked": ("ITEM", "USER_PERMISSION_REVOKED", None),
    "user_account_revoked": ("ITEM", "USER_ACCOUNT_REVOKED", None),
    "login_repaired": ("ITEM", "LOGIN_REPAIRED", None),
    "unknown_code": ("ITEM", "NEW_ACCOUNTS_AVAILABLE", None),
}
LOGIN = {"ok": "login_required", "login_required": "login_required", "revoked": "login_required"}
EXPECTED: dict[str, dict[str, str]] = {
    "updates_available": {"ok": "ok", "login_required": "login_required", "revoked": "revoked"},
    "item_error_login": LOGIN,
    "item_error_other": {"ok": "ok", "login_required": "login_required", "revoked": "revoked"},
    "pending_expiration": LOGIN,
    "pending_disconnect": LOGIN,
    "user_permission_revoked": {"ok": "revoked", "login_required": "revoked", "revoked": "revoked"},
    "user_account_revoked": {"ok": "revoked", "login_required": "revoked", "revoked": "revoked"},
    "login_repaired": {"ok": "ok", "login_required": "ok", "revoked": "ok"},
    "unknown_code": {"ok": "ok", "login_required": "login_required", "revoked": "revoked"},
    # The person's own routes. Sync and cards read a revoked connection as 409 and change nothing.
    "sync_ok": {"ok": "ok", "login_required": "ok", "revoked": "revoked"},
    "sync_login_required": {
        "ok": "login_required",
        "login_required": "login_required",
        "revoked": "revoked",
    },
    "cards_ok": {"ok": "ok", "login_required": "login_required", "revoked": "revoked"},
    "cards_login_required": {
        "ok": "login_required",
        "login_required": "login_required",
        "revoked": "revoked",
    },
    "relink_finished": {"ok": "ok", "login_required": "ok", "revoked": "ok"},
    "disconnect_plaid_up": {"ok": GONE, "login_required": GONE, "revoked": GONE},
    "disconnect_plaid_down": {
        "ok": "revoke_pending",
        "login_required": "revoke_pending",
        "revoked": "revoke_pending",
    },
}
for _after in EXPECTED.values():
    _after.setdefault("revoke_pending", "revoke_pending")

CASES = [(event, before) for event in EXPECTED for before in STATUSES]


def _happen(client, fake: FakePlaid, conn_id: str, event: str) -> None:
    if event in WEBHOOKS:
        _hook(fake, conn_id, *WEBHOOKS[event])
    elif event.startswith("sync"):
        fake.sync_error = "ITEM_LOGIN_REQUIRED" if event == "sync_login_required" else None
        client.post(f"/api/linking/{conn_id}/sync", json={})
    elif event.startswith("cards"):
        fake.liabilities_error = "ITEM_LOGIN_REQUIRED" if event == "cards_login_required" else None
        client.post(f"/api/linking/{conn_id}/cards")
    elif event == "relink_finished":
        r = client.post(
            f"/api/linking/{conn_id}/relink", headers={"Origin": "http://localhost:5173"}
        )
        if r.status_code == 200:
            client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    elif event.startswith("disconnect"):
        fake.fail_remove = event == "disconnect_plaid_down"
        client.delete(f"/api/linking/{conn_id}")
    else:  # pragma: no cover - the table names every event
        raise AssertionError(event)


@pytest.mark.parametrize(("event", "before"), CASES, ids=[f"{e}-{b}" for e, b in CASES])
def test_each_status_and_event(fake: FakePlaid, event: str, before: str) -> None:
    client, _, conn_id, access = linked(fake)
    _set(conn_id, before)
    _happen(client, fake, conn_id, event)
    assert _status(conn_id) == EXPECTED[event][before]
    listed = [c["id"] for c in client.get("/api/linking").json()["connections"]]
    assert (conn_id in listed) == (EXPECTED[event][before] not in ("revoke_pending", GONE))
    if before == "revoke_pending":
        # ...and it still ends revoked: the next run of the job revokes the token at Plaid.
        fake.fail_remove = False
        with get_session_factory()() as db:
            revoke_due(db)
        assert _status(conn_id) == GONE
        assert access in fake.removed


def test_a_webhook_after_a_disconnect_plaid_missed_never_brings_the_bank_back(
    fake: FakePlaid,
) -> None:
    """The owner's case, end to end: Disconnect while Plaid is down, then the bank's webhooks."""
    client, _, conn_id, access = linked(fake)
    fake.fail_remove = True
    assert client.delete(f"/api/linking/{conn_id}").status_code == 204
    for event in ("pending_expiration", "login_repaired", "user_permission_revoked"):
        _hook(fake, conn_id, *WEBHOOKS[event])
        assert _status(conn_id) == "revoke_pending", event
        assert client.get("/api/linking").json()["connections"] == []
    fake.fail_remove = False
    with get_session_factory()() as db:
        revoke_due(db)
    assert _status(conn_id) == GONE and access in fake.removed


def test_a_sync_under_way_when_the_disconnect_lands_never_undoes_it(fake: FakePlaid) -> None:
    """A sync read the row, Plaid answered slowly, and meanwhile the person disconnected while
    Plaid's remove failed: the sync's status write must not bring the connection back."""
    client, _, conn_id, _ = linked(fake)
    _set(conn_id, "login_required")  # a good sync would set it back to ok
    inner = fake.transport()

    def slow(request):
        if request.url.path == "/transactions/sync":
            _set(conn_id, "revoke_pending")  # the disconnect commits while Plaid is answering
        return inner.handle_request(request)

    import httpx2

    plaid.transport_override = httpx2.MockTransport(slow)
    client.post(f"/api/linking/{conn_id}/sync", json={})
    assert _status(conn_id) == "revoke_pending"

    _set(conn_id, "ok")
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    client.post(f"/api/linking/{conn_id}/sync", json={})
    assert _status(conn_id) == "revoke_pending"


def _gone(conn_id: str) -> None:
    """A Disconnect whose revoke succeeded: the row is deleted."""
    with get_session_factory()() as db:
        row = db.scalar(select(BankConnection).where(BankConnection.id == uuid.UUID(conn_id)))
        if row is not None:
            db.delete(row)
            db.commit()


# The person's call -> the Plaid path it waits on.
RACES = {
    "sync": "/transactions/sync",
    "sync_login_required": "/transactions/sync",
    "cards": "/liabilities/get",
    "cards_login_required": "/liabilities/get",
    "relink": "/link/token/create",
}
# Finishing a relink holds its link session FOR UPDATE, and the connection's delete waits on
# that row (the foreign key), so a revoke can't delete the row under a finishing relink.


@pytest.mark.parametrize("event", list(RACES))
def test_a_call_waiting_on_plaid_when_the_revoke_deletes_the_row_answers_404(
    fake: FakePlaid, event: str
) -> None:
    """A sync, card read or relink read the row, then waited on Plaid while a Disconnect's
    revoke succeeded and deleted it: the call answers 404 like any gone connection, never 500."""
    import httpx2

    client, _, conn_id, _ = linked(fake)
    origin = {"Origin": "http://localhost:5173"}
    fake.sync_error = "ITEM_LOGIN_REQUIRED" if event == "sync_login_required" else None
    fake.liabilities_error = "ITEM_LOGIN_REQUIRED" if event == "cards_login_required" else None
    inner = fake.transport()

    def racing(request):
        if request.url.path == RACES[event]:
            _gone(conn_id)
        return inner.handle_request(request)

    plaid.transport_override = httpx2.MockTransport(racing)
    if event.startswith("sync"):
        r = client.post(f"/api/linking/{conn_id}/sync", json={})
    elif event.startswith("cards"):
        r = client.post(f"/api/linking/{conn_id}/cards")
    else:
        r = client.post(f"/api/linking/{conn_id}/relink", headers=origin)
    assert r.status_code == 404, r.text
    assert _status(conn_id) == GONE
