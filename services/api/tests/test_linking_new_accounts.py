"""Invariant 96 (November 23, 2026): a bank's new accounts are offered, never added unasked.

Plaid's NEW_ACCOUNTS_AVAILABLE marks the connection; Linked banks offers "Add them", which opens
Plaid's update mode with account selection after a passkey check, on the same item (no new
connection, no second fee). Finishing the trip clears the offer; leaving Plaid's page, a
webhook about a later account, or Plaid failing keeps it; Not now clears it until the next
webhook. Every refusal changes nothing and asks Plaid for nothing."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, text

from app.db import get_session_factory
from app.linking import plaid, webhook_verify
from app.models.audit_log import AuditLog
from app.models.linking import BankConnection
from app.models.user import User
from tests.auth_flow import new_client, outbox
from tests.plaid_fake import FakePlaid
from tests.test_linking import member
from tests.test_linking_sync import _end_plan, item_of, linked, sign

ORIGIN = {"Origin": "http://localhost:5173"}
NEW_CARD = {
    "account_id": "acc-new",
    "name": "Plaid Rewards Card",
    "mask": "4444",
    "type": "credit",
    "subtype": "credit card",
    "balances": {"current": 0, "limit": 5000},
}


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


def _hook(fake: FakePlaid, item_id: str, code: str = "NEW_ACCOUNTS_AVAILABLE", **extra):
    body = json.dumps({"webhook_type": "ITEM", "webhook_code": code, "item_id": item_id}).encode()
    headers = {"Plaid-Verification": extra.get("token") or sign(fake, body)}
    return new_client().post("/api/webhooks/plaid", content=body, headers=headers)


def _conn(client) -> dict:
    return client.get("/api/linking").json()["connections"][0]


def _row(conn_id: str) -> BankConnection:
    with get_session_factory()() as db:
        row = db.get(BankConnection, uuid.UUID(conn_id))
        assert row is not None
        return row


def _set_status(conn_id: str, value: str) -> None:
    with get_session_factory()() as db, db.begin():
        db.get(BankConnection, uuid.UUID(conn_id)).status = value  # type: ignore[union-attr]


def _added_audits(user_id: str) -> int:
    with get_session_factory()() as db:
        return int(
            db.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.actor_id == uuid.UUID(user_id),
                    AuditLog.action == "bank_accounts_added",
                )
            )
            or 0
        )


def _subjects() -> list[str]:
    return [m.subject for m in outbox()]


def _flagged(fake: FakePlaid):
    client, user_id, conn_id, access = linked(fake)
    assert _conn(client)["new_accounts"] is False
    r = _hook(fake, item_of(conn_id))
    assert r.status_code == 200 and r.json()["outcome"] == "new_accounts"
    assert _conn(client)["new_accounts"] is True
    outbox().clear()
    return client, user_id, conn_id, access


def _start_add(client, conn_id: str):
    return client.post(f"/api/linking/{conn_id}/add-accounts", headers=ORIGIN)


def test_adding_accounts_uses_the_same_item_and_clears_the_offer(fake: FakePlaid) -> None:
    client, user_id, conn_id, access = _flagged(fake)
    exchanges = len(fake.bodies("/item/public_token/exchange"))
    fake.extra_accounts = [NEW_CARD]

    r = _start_add(client, conn_id)
    assert r.status_code == 200, r.text
    body = fake.bodies("/link/token/create")[-1]
    assert body["access_token"] == access  # update mode on the item we hold
    assert body["update"] == {"account_selection_enabled": True}
    assert "products" not in body  # update mode asks for nothing new

    r = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "linked"
    assert [a["account_id"] for a in out["connections"][0]["accounts"]] == [
        "acc-chk",
        "acc-cc",
        "acc-new",
    ]
    conn = _conn(client)
    assert conn["new_accounts"] is False and conn["status"] == "ok"
    assert len(client.get("/api/linking").json()["connections"]) == 1  # no second connection
    assert len(fake.bodies("/item/public_token/exchange")) == exchanges  # no new item, no fee
    assert _added_audits(user_id) == 1
    assert _subjects() == ["Your shared bank accounts changed"]


def test_not_now_clears_the_offer_until_plaid_says_so_again(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    assert client.post(f"/api/linking/{conn_id}/new-accounts/dismiss").status_code == 204
    assert _conn(client)["new_accounts"] is False
    assert client.post(f"/api/linking/{conn_id}/new-accounts/dismiss").status_code == 204
    _hook(fake, item_of(conn_id))
    assert _conn(client)["new_accounts"] is True


def test_sign_in_again_neither_asks_for_accounts_nor_clears_the_offer(fake: FakePlaid) -> None:
    client, user_id, conn_id, _ = _flagged(fake)
    r = client.post(f"/api/linking/{conn_id}/relink", headers=ORIGIN)
    assert r.status_code == 200
    assert "update" not in fake.bodies("/link/token/create")[-1]
    client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert _conn(client)["new_accounts"] is True
    assert _added_audits(user_id) == 0 and _subjects() == []


def test_leaving_plaids_page_keeps_the_offer_and_says_nothing(fake: FakePlaid) -> None:
    client, user_id, conn_id, _ = _flagged(fake)
    r = _start_add(client, conn_id)
    fake.exited.add(r.json()["url"].rsplit("/", 1)[-1])
    out = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert out.status_code == 200 and out.json() == {
        "status": "cancelled",
        "connections": [],
        "already_linked": [],
        "failed": [],
    }
    assert _conn(client)["new_accounts"] is True
    assert _added_audits(user_id) == 0 and _subjects() == []
    assert not fake.bodies("/accounts/get")[1:]  # nothing read after the link itself


def test_a_webhook_about_a_later_account_survives_the_trip(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    r = _start_add(client, conn_id)
    _hook(fake, item_of(conn_id))  # another account opened while the person was at Plaid
    client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert _conn(client)["new_accounts"] is True


def test_plaid_failing_at_the_finish_keeps_the_offer(fake: FakePlaid) -> None:
    client, user_id, conn_id, _ = _flagged(fake)
    r = _start_add(client, conn_id)
    fake.token_get_error = "INTERNAL_SERVER_ERROR"
    out = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert out.status_code == 502
    fake.token_get_error = None
    assert _conn(client)["new_accounts"] is True and _conn(client)["status"] == "ok"
    assert _added_audits(user_id) == 0
    # The trip is spent; finishing it again is refused and a fresh one works.
    again = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert again.status_code == 409 and again.json()["detail"] == "session_used"
    r = _start_add(client, conn_id)
    assert (
        client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]}).json()[
            "status"
        ]
        == "linked"
    )
    assert _conn(client)["new_accounts"] is False


def test_bank_asking_to_sign_in_during_the_trip_keeps_the_offer(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    r = _start_add(client, conn_id)
    fake.accounts_error, fake.accounts_failures = "ITEM_LOGIN_REQUIRED", 1
    out = client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert out.json()["status"] == "cancelled"
    assert _conn(client)["new_accounts"] is True


def _stale_step_up(client) -> None:
    session_id = client.get("/api/auth/session").json()["session_id"]
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": session_id},
        )


def test_adding_accounts_needs_a_fresh_passkey_check(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    creates = len(fake.bodies("/link/token/create"))
    _stale_step_up(client)
    r = _start_add(client, conn_id)
    assert r.status_code == 403 and r.json()["detail"] == "step_up_required"
    assert len(fake.bodies("/link/token/create")) == creates
    # Not now needs no passkey check: it shares nothing
    assert client.post(f"/api/linking/{conn_id}/new-accounts/dismiss").status_code == 204


def test_adding_accounts_waits_a_day_after_an_email_only_recovery(fake: FakePlaid) -> None:
    client, user_id, conn_id, _ = _flagged(fake)
    with get_session_factory()() as db, db.begin():
        db.get(User, uuid.UUID(user_id)).recovered_at = datetime.now(UTC)  # type: ignore[union-attr]
    r = _start_add(client, conn_id)
    assert r.status_code == 403 and r.json()["detail"] == "recently_recovered"
    assert _conn(client)["new_accounts"] is True


def test_adding_accounts_needs_a_plan_that_links(fake: FakePlaid) -> None:
    client, user_id, conn_id, _ = _flagged(fake)
    creates = len(fake.bodies("/link/token/create"))
    _end_plan(user_id)
    r = _start_add(client, conn_id)
    assert r.status_code == 403 and r.json()["detail"] == "plan_required"
    assert len(fake.bodies("/link/token/create")) == creates


def test_a_revoked_connection_is_neither_offered_nor_opened(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    _set_status(conn_id, "revoked")
    assert _conn(client)["new_accounts"] is False  # "Disconnect, then link again" instead
    r = _start_add(client, conn_id)
    assert r.status_code == 409 and r.json()["detail"] == "connection_revoked"


def test_a_connection_needing_sign_in_still_offers_and_the_trip_repairs_it(
    fake: FakePlaid,
) -> None:
    client, _, conn_id, _ = _flagged(fake)
    _set_status(conn_id, "login_required")
    assert _conn(client)["new_accounts"] is True
    r = _start_add(client, conn_id)
    client.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    conn = _conn(client)
    assert conn["status"] == "ok" and conn["new_accounts"] is False


def test_someone_elses_connection_is_not_found(fake: FakePlaid) -> None:
    _, _, conn_id, _ = _flagged(fake)
    other, _ = member("sam")
    assert _start_add(other, conn_id).status_code == 404
    assert other.post(f"/api/linking/{conn_id}/new-accounts/dismiss").status_code == 404
    assert _row(conn_id).new_accounts_at is not None


def test_a_connection_being_removed_ignores_the_news_and_the_buttons(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    _set_status(conn_id, "revoke_pending")
    r = _hook(fake, item_of(conn_id))
    assert r.json()["outcome"] == "being_removed"
    assert _row(conn_id).new_accounts_at is None
    assert _start_add(client, conn_id).status_code == 404
    assert client.post(f"/api/linking/{conn_id}/new-accounts/dismiss").status_code == 404


def test_an_unsigned_or_unknown_webhook_changes_nothing(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    r = _hook(fake, item_of(conn_id), token="not.a.jwt")
    assert r.status_code == 400
    assert _conn(client)["new_accounts"] is False
    r = _hook(fake, "item-nobody-holds")
    assert r.status_code == 200 and r.json()["outcome"] == "unknown_item"


def test_another_session_cannot_finish_my_trip(fake: FakePlaid) -> None:
    client, _, conn_id, _ = _flagged(fake)
    r = _start_add(client, conn_id)
    other, _ = member("sam")
    out = other.post("/api/linking/finish", json={"session_id": r.json()["session_id"]})
    assert out.status_code == 404
    assert _conn(client)["new_accounts"] is True
