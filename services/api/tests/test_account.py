"""Export, deletion and email change (docs/spec.md "Download all my data", "Delete account")."""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.db import get_session_factory
from app.services.deletion import purge_due
from tests.auth_flow import new_client, outbox, send_code, sign_in_with_code, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def fresh_email(name: str) -> str:
    return f"{name}+{uuid.uuid4().hex[:6]}@example.com"


def test_export_adds_account_and_groups_and_is_alerted() -> None:
    client = new_client()
    email = fresh_email("maya")
    sign_up(client, email, FakeAuthenticator())  # the passkey check is fresh: step-up passes
    client.patch("/api/account", json={"display_name": "Maya R."})
    grant_plan(client.get("/api/auth/session").json()["user"]["id"], "private")
    gid = client.post("/api/groups", json={"name": "October", "month": "2026-10"}).json()["id"]
    outbox().clear()

    r = client.get("/api/account/export")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["profile"]["email"] == email
    assert data["profile"]["display_name"] == "Maya R."
    assert data["profile"]["receipt_retention"] == "90d"
    assert [g["id"] for g in data["groups"]] == [gid]
    assert data["plan"]["name"] == "private" and data["plan"]["status"] == "active"
    assert data["plan"]["interval"] == "yearly" and data["plan"]["renews_at"] is not None
    assert "cents" not in r.text  # nothing about money lives on the server
    assert [m.to for m in outbox()] == [email]
    assert "export" in outbox()[-1].subject.lower()


def test_delete_soft_deletes_now_and_purges_after_the_grace_period() -> None:
    alice, bob = new_client(), new_client()
    alice_email = fresh_email("alice")
    alice_info = sign_up(alice, alice_email, FakeAuthenticator())
    sign_up(bob, fresh_email("bob"), FakeAuthenticator())
    alice.patch("/api/account", json={"display_name": "Alice"})
    grant_plan(alice_info["user"]["id"], "private")
    group = alice.post("/api/groups", json={"name": "Shared", "month": "2026-10"}).json()
    bob.post("/api/groups/join", json={"code": group["invite_code"]})
    outbox().clear()

    assert alice.post("/api/account/delete", json={"confirm": "delete"}).status_code == 422
    r = alice.post("/api/account/delete", json={"confirm": "DELETE"})
    assert r.status_code == 204, r.text
    assert any("delet" in m.subject.lower() and m.to == alice_email for m in outbox())
    # Signed out everywhere, and the account no longer answers
    assert alice.get("/api/auth/session").json()["authenticated"] is False
    # Bob still sees the group; Alice is a former member with no name
    detail = bob.get(f"/api/groups/{group['id']}").json()
    former = [m for m in detail["members"] if m["former"]]
    assert len(former) == 1 and former[0]["display_name"] == "Former member"
    assert alice_email not in bob.get(f"/api/groups/{group['id']}").text
    # The address is free again: signing in creates a fresh account
    again = new_client()
    info = sign_in_with_code(again, alice_email)
    assert info["user"]["id"] != alice_info["user"]["id"]

    # The purge after the grace period removes the row and what cascades from it
    with get_session_factory()() as s, s.begin():
        assert purge_due(s, grace_days=30, now=datetime.now(UTC) + timedelta(days=29)) == 0
        assert purge_due(s, grace_days=30, now=datetime.now(UTC) + timedelta(days=31)) == 1
    detail = bob.get(f"/api/groups/{group['id']}").json()
    assert detail["member_count"] == 1 and not any(m["former"] for m in detail["members"])
    assert detail["is_owner"] is True  # the group passed to Bob when Alice deleted her account


def test_change_email_sends_a_code_to_the_new_address() -> None:
    client = new_client()
    old = fresh_email("old")
    sign_up(client, old, FakeAuthenticator())
    other = new_client()
    taken = fresh_email("taken")
    sign_up(other, taken, FakeAuthenticator())
    outbox().clear()

    assert client.post("/api/account/email/send", json={"new_email": old}).status_code == 409
    assert client.post("/api/account/email/send", json={"new_email": taken}).status_code == 409
    new = fresh_email("new")
    r = client.post("/api/account/email/send", json={"new_email": new})
    assert r.status_code == 200, r.text
    assert outbox()[-1].to == new
    code = re.search(r"\b(\d{6})\b", outbox()[-1].text).group(1)
    assert (
        client.post(
            "/api/account/email/verify", json={"new_email": new, "code": "000000"}
        ).status_code
        == 400
    )
    r = client.post("/api/account/email/verify", json={"new_email": new, "code": code})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == new
    assert client.get("/api/auth/session").json()["user"]["email"] == new
    assert {m.to for m in outbox() if "email" in m.subject.lower()} >= {old, new}


def test_email_change_takes_only_a_code_from_its_own_step_up_send() -> None:
    """A sign-in code (the public send answers for any address) or another account's
    email-change code never changes this account's email."""
    victim = new_client()
    old = fresh_email("victim")
    sign_up(victim, old, FakeAuthenticator())
    attacker_email = fresh_email("attacker")
    signin_code = send_code(new_client(), attacker_email)
    r = victim.post(
        "/api/account/email/verify", json={"new_email": attacker_email, "code": signin_code}
    )
    assert r.status_code == 400 and r.json()["detail"]["code"] == "wrong_code", r.text
    assert victim.get("/api/auth/session").json()["user"]["email"] == old

    # Another account's pending change: its code is bound to that account.
    other = new_client()
    sign_up(other, fresh_email("other"), FakeAuthenticator())
    target = fresh_email("target")
    assert other.post("/api/account/email/send", json={"new_email": target}).status_code == 200
    code = re.search(r"\b(\d{6})\b", outbox()[-1].text).group(1)
    r = victim.post("/api/account/email/verify", json={"new_email": target, "code": code})
    assert r.status_code == 400, r.text
    assert victim.get("/api/auth/session").json()["user"]["email"] == old


def test_look_is_saved_on_the_account_and_read_by_the_session() -> None:
    """Chunk 2.2: the native apps pick a look; every client reads it with the session."""
    client = new_client()
    sign_up(client, f"maya+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    assert client.get("/api/auth/session").json()["user"]["look"] == "modern"
    r = client.patch("/api/account", json={"look": "anime"})
    assert r.status_code == 200, r.text
    assert r.json()["look"] == "anime"
    assert client.get("/api/auth/session").json()["user"]["look"] == "anime"
    # the name alone still works, and an empty patch or an unknown look is refused
    assert client.patch("/api/account", json={"display_name": "Maya"}).json()["look"] == "anime"
    assert client.patch("/api/account", json={}).status_code == 422
    assert client.patch("/api/account", json={"look": "bento"}).status_code == 422
