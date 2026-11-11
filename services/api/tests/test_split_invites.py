"""Invites waiting (owner, November 11, 2026): the same inbox is never invited twice while an
invite waits; the organizer reminds instead, once a day per invite, with the address they typed
(the server keeps only its hash, so a reminder can go nowhere else); the list says how many
invites are left today."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from app.db import get_session_factory
from app.models.split import SplitInvite
from tests.auth_flow import outbox
from tests.test_splits import TOKEN, person


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def _age_invites(days: float) -> None:
    """Moves every invite's send and reminder back in time, as if a day went by."""
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(SplitInvite).values(
                created_at=SplitInvite.created_at - timedelta(days=days),
                reminded_at=SplitInvite.reminded_at - timedelta(days=days),
            )
        )


def test_the_same_inbox_is_not_invited_twice_while_an_invite_waits() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    target = f"sam+{uuid.uuid4().hex[:6]}@example.com"
    first = jordan.post(f"/api/splits/{gid}/invites", json={"email": target})
    assert first.status_code == 201
    outbox().clear()
    again = jordan.post(f"/api/splits/{gid}/invites", json={"email": target.upper()})
    assert again.status_code == 409 and again.json()["detail"] == "already_invited"
    assert outbox() == []  # no second email
    status = jordan.get("/api/splits").json()
    assert status["invites_today"] == {"added": 1, "limit": 6}  # the refused one isn't counted
    assert [i["id"] for i in status["groups"][0]["invites"]] == [first.json()["id"]]


def test_a_reminder_goes_once_a_day_to_the_address_invited_with_a_new_link() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = jordan.post("/api/splits").json()["id"]
    sent = jordan.post(f"/api/splits/{gid}/invites", json={"email": sam[2]}).json()
    old_token, iid = sent["token"], sent["id"]
    url = f"/api/splits/{gid}/invites/{iid}/remind"

    # The day it was sent counts as today's message.
    r = jordan.post(url, json={"email": sam[2]})
    assert r.status_code == 429 and r.json()["detail"] == "remind_tomorrow"
    _age_invites(1)

    # Only the address it was sent to: anything else is refused and nothing is sent.
    outbox().clear()
    r = jordan.post(url, json={"email": "someone-else@example.com"})
    assert r.status_code == 422 and r.json()["detail"] == "not_this_invite"
    assert outbox() == []

    r = jordan.post(url, json={"email": sam[2]})
    assert r.status_code == 200, r.text
    mail = [m for m in outbox() if m.to == sam[2]]
    assert (
        len(mail) == 1
        and mail[0].subject == "Reminder: Jordan K. invited you to split bills on Qash"
    )
    new_token = TOKEN.search(mail[0].text).group(1)
    assert new_token == r.json()["token"] != old_token
    # Same 7 days: a reminder never stretches the invite.
    same = datetime.fromisoformat(r.json()["expires_at"]) == datetime.fromisoformat(
        sent["expires_at"]
    )
    assert same
    listed = jordan.get("/api/splits").json()["groups"][0]["invites"][0]
    assert listed["reminded_at"] is not None
    # Not counted against today's invites.
    assert jordan.get("/api/splits").json()["invites_today"]["added"] == 0

    again = jordan.post(url, json={"email": sam[2]})
    assert again.status_code == 429 and again.json()["detail"] == "remind_tomorrow"

    # The old link is dead; the new one works.
    assert sam[0].post("/api/splits/invites/lookup", json={"token": old_token}).status_code == 404
    assert sam[0].post("/api/splits/invites/accept", json={"token": new_token}).status_code == 200


def test_no_reminder_for_an_invite_that_is_closed() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    target = f"alex+{uuid.uuid4().hex[:6]}@example.com"
    iid = jordan.post(f"/api/splits/{gid}/invites", json={"email": target}).json()["id"]
    _age_invites(1)
    assert jordan.delete(f"/api/splits/{gid}/invites/{iid}").status_code == 204
    r = jordan.post(f"/api/splits/{gid}/invites/{iid}/remind", json={"email": target})
    assert r.status_code == 404
    # A cancelled invite frees the inbox for a new one.
    assert jordan.post(f"/api/splits/{gid}/invites", json={"email": target}).status_code == 201

    iid2 = jordan.get("/api/splits").json()["groups"][0]["invites"][0]["id"]
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(SplitInvite).values(
                expires_at=datetime.now(UTC) - timedelta(seconds=1),
                created_at=SplitInvite.created_at - timedelta(days=2),
            )
        )
    r = jordan.post(f"/api/splits/{gid}/invites/{iid2}/remind", json={"email": target})
    assert r.status_code == 404


def test_only_the_organizer_reminds() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = jordan.post("/api/splits").json()["id"]
    token = jordan.post(f"/api/splits/{gid}/invites", json={"email": sam[2]}).json()["token"]
    assert sam[0].post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    target = f"pat+{uuid.uuid4().hex[:6]}@example.com"
    iid = jordan.post(f"/api/splits/{gid}/invites", json={"email": target}).json()["id"]
    _age_invites(1)
    r = sam[0].post(f"/api/splits/{gid}/invites/{iid}/remind", json={"email": target})
    assert r.status_code == 403 and r.json()["detail"] == "organizer_only"
