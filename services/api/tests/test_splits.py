"""Split bills on the server (docs/spec.md "Split bills"; chunk S.2; invariants 77–79).

The server holds who is in which group, invites bound to one inbox, issued bill ids, disputes,
mistakes and reports. It decides the daily limit, the people limit, the 7-day single-use invite,
the double-check after 3 mistakes in 30 days and the block after 3 different reporters. It
never sees an amount, a name in a bill, or a group's name.
"""

import base64
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app.cli import split_unblock
from app.db import get_session_factory
from app.models.split import SplitBill, SplitInvite, SplitMistake, SplitPayConsent
from app.models.user import User
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator

TOKEN = re.compile(r"/splits/join#t=([A-Za-z0-9_-]+)")


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def person(name: str, plan: str | None = None):
    email = f"{name.split()[0].lower()}+{uuid.uuid4().hex[:6]}@example.com"
    client = new_client()
    sign_up(client, email, FakeAuthenticator())
    client.patch("/api/account", json={"display_name": name})
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    if plan:
        grant_plan(user_id, plan)
    return client, user_id, email


def invite_token(organizer, group_id: str, email: str) -> str:
    outbox().clear()
    r = organizer.post(f"/api/splits/{group_id}/invites", json={"email": email})
    assert r.status_code == 201, r.text
    sent = [m for m in outbox() if m.to == email]
    assert len(sent) == 1
    found = TOKEN.search(sent[0].text)
    assert found and found.group(1) == r.json()["token"]
    return found.group(1)


def group_with(organizer, guests: list) -> str:
    gid = organizer.post("/api/splits").json()["id"]
    for client, _, email in guests:
        token = invite_token(organizer, gid, email)
        assert client.post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    return gid


def test_only_a_paid_plan_runs_a_group_and_guests_join_free() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    status = sam[0].get("/api/splits").json()
    assert status["guest"] is True and status["can_create"] is False
    r = sam[0].post("/api/splits")
    assert r.status_code == 403 and r.json()["detail"] == "plan_required"

    gid = group_with(jordan, [sam])
    mine = sam[0].get("/api/splits").json()
    assert [g["id"] for g in mine["groups"]] == [gid]
    people = {m["display_name"]: m for m in mine["groups"][0]["members"]}
    assert people["Jordan K."]["is_organizer"] and not people["Jordan K."]["guest"]
    assert people["Sam L."]["guest"] and people["Sam L."]["is_me"]


def test_the_invite_email_names_who_asks_and_nothing_else() -> None:
    jordan, _, jordan_email = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    target = f"alex+{uuid.uuid4().hex[:6]}@example.com"
    invite_token(jordan, gid, target)
    message = next(m for m in outbox() if m.to == target)
    assert message.subject == "Jordan K. invited you to split bills on Qash"
    masked = f"{jordan_email[0]}•••@example.com"
    assert f"Jordan K. ({masked})" in message.text
    assert "$" not in message.text and jordan_email not in message.text


def test_an_invite_is_for_its_own_inbox_once_for_seven_days() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    priya = person("Priya N.")
    gid = jordan.post("/api/splits").json()["id"]
    token = invite_token(jordan, gid, sam[2])

    r = priya[0].post("/api/splits/invites/lookup", json={"token": token})
    assert r.status_code == 403 and r.json()["detail"] == "other_email"
    card = sam[0].post("/api/splits/invites/lookup", json={"token": token}).json()
    assert card["organizer_name"] == "Jordan K."
    assert card["organizer_email"].endswith("@example.com") and "•" in card["organizer_email"]
    assert card["pays_with_card"] is True and card["people"] == 1
    assert re.fullmatch(r"\d{4}-\d{2}", card["member_since"])

    assert sam[0].post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    again = sam[0].post("/api/splits/invites/accept", json={"token": token})
    assert again.status_code == 404  # used once

    token2 = invite_token(jordan, gid, priya[2])
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(SplitInvite)
            .where(SplitInvite.used_at.is_(None))
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    assert priya[0].post("/api/splits/invites/accept", json={"token": token2}).status_code == 404


def test_people_per_group_follow_the_organizers_plan() -> None:
    jordan, _, _ = person("Jordan K.", "private")  # 6 people, the organizer included
    gid = jordan.post("/api/splits").json()["id"]
    for i in range(5):
        r = jordan.post(
            f"/api/splits/{gid}/invites", json={"email": f"p{i}{uuid.uuid4().hex[:4]}@example.com"}
        )
        assert r.status_code == 201, r.text
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": "seventh@example.com"})
    assert r.status_code == 403 and r.json()["detail"] == "plan_limit"


def test_bills_a_day_count_for_the_organizer_whoever_adds_them() -> None:
    jordan, _, _ = person("Jordan K.", "private")  # 6 a day
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    for n in range(1, 7):
        adder = jordan if n % 2 else sam[0]
        r = adder.post(f"/api/splits/{gid}/bills")
        assert r.status_code == 201, r.text
        assert r.json()["today"] == {"added": n, "limit": 6}
    r = sam[0].post(f"/api/splits/{gid}/bills")
    assert r.status_code == 429 and r.json()["detail"] == "daily_limit"
    assert jordan.get("/api/splits").json()["today"] == {"added": 6, "limit": 6}
    # Every issued id is listed for the devices (invariant 77)
    assert len(sam[0].get(f"/api/splits/{gid}/state").json()["bill_ids"]) == 6


def test_connected_runs_twelve_a_day() -> None:
    jordan, _, _ = person("Jordan K.", "connected")
    gid = jordan.post("/api/splits").json()["id"]
    for _ in range(12):
        assert jordan.post(f"/api/splits/{gid}/bills").status_code == 201
    assert jordan.post(f"/api/splits/{gid}/bills").status_code == 429


def test_dont_know_them_blocks_that_sender_and_three_mistakes_switch_on_double_check() -> None:
    jordan, jordan_id, _ = person("Jordan K.", "connected")
    gid = jordan.post("/api/splits").json()["id"]
    strangers = [person(f"Stranger{i} X.") for i in range(3)]
    for s in strangers:
        token = invite_token(jordan, gid, s[2])
        r = s[0].post("/api/splits/invites/decline", json={"token": token})
        assert r.status_code == 204
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": strangers[0][2]})
    assert r.status_code == 409 and r.json()["detail"] == "declined_before"
    assert jordan.get("/api/splits").json()["double_check"] is True
    # Now every invite needs the email typed twice, matching
    target = f"newfriend+{uuid.uuid4().hex[:4]}@example.com"
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": target})
    assert r.status_code == 422 and r.json()["detail"] == "emails_differ"
    r = jordan.post(
        f"/api/splits/{gid}/invites", json={"email": target, "email_again": "newfriend@exmaple.com"}
    )
    assert r.status_code == 422
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": target, "email_again": target})
    assert r.status_code == 201
    # 30 days with no new mistake switch it off
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(SplitMistake)
            .where(SplitMistake.user_id == uuid.UUID(jordan_id))
            .values(created_at=datetime.now(UTC) - timedelta(days=31))
        )
    assert jordan.get("/api/splits").json()["double_check"] is False


def test_a_disputed_bill_is_a_mistake_for_whoever_added_it() -> None:
    jordan, jordan_id, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    bill = jordan.post(f"/api/splits/{gid}/bills").json()["id"]
    assert sam[0].post(f"/api/splits/{gid}/disputes", json={"bill_id": bill}).status_code == 204
    state = jordan.get(f"/api/splits/{gid}/state").json()
    assert [d["bill_id"] for d in state["disputes"]] == [bill]
    with get_session_factory()() as db:
        kinds = db.scalars(
            select(SplitMistake.kind).where(SplitMistake.user_id == uuid.UUID(jordan_id))
        ).all()
    assert kinds == ["bill_disputed"]
    # The organizer fixes it: every dispute on it closes
    assert jordan.post(f"/api/splits/{gid}/disputes/{bill}/close").status_code == 204
    assert jordan.get(f"/api/splits/{gid}/state").json()["disputes"] == []


def test_three_different_reporters_block_the_organizer_until_support_lifts_it() -> None:
    jordan, jordan_id, _ = person("Jordan K.", "connected")
    guests = [person(f"Guest{i} Y.") for i in range(3)]
    gid = group_with(jordan, guests)
    for i, g in enumerate(guests[:2]):
        r = g[0].post(f"/api/splits/{gid}/leave", json={"report": "not_owed"})
        assert r.status_code == 204
        assert jordan.get("/api/splits").json()["blocked"] is False, i
    # One person reporting twice counts once; the third different person blocks
    guests[2][0].post(f"/api/splits/{gid}/leave", json={"report": "pushy"})
    status = jordan.get("/api/splits").json()
    assert status["blocked"] is True and status["can_create"] is False
    assert jordan.post("/api/splits").json()["detail"] == "split_blocked"
    r = jordan.post(f"/api/splits/{gid}/bills")
    assert r.status_code == 409 and r.json()["detail"] == "read_only"

    assert split_unblock(jordan_id) == 0
    assert jordan.get("/api/splits").json()["blocked"] is False
    assert jordan.post("/api/splits").status_code == 201


def test_when_the_organizer_cant_run_it_the_group_is_view_and_settle_until_taken_over() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    alex = person("Alex M.", "private")
    gid = group_with(jordan, [sam, alex])
    assert jordan.post(f"/api/splits/{gid}/leave", json={}).status_code == 204
    state = sam[0].get(f"/api/splits/{gid}/state").json()
    assert state["writable"] is False
    assert sam[0].post(f"/api/splits/{gid}/bills").json()["detail"] == "read_only"
    assert sam[0].post(f"/api/splits/{gid}/takeover").json()["detail"] == "plan_required"
    r = alex[0].post(f"/api/splits/{gid}/takeover")
    assert r.status_code == 200 and r.json()["is_organizer"] is True
    assert sam[0].post(f"/api/splits/{gid}/bills").status_code == 201


def test_only_the_organizer_invites_and_removes() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    alex = person("Alex M.")
    gid = group_with(jordan, [sam, alex])
    r = sam[0].post(f"/api/splits/{gid}/invites", json={"email": "x@example.com"})
    assert r.status_code == 403 and r.json()["detail"] == "organizer_only"
    group = jordan.get("/api/splits").json()["groups"][0]
    alex_member = next(m["member_id"] for m in group["members"] if m["display_name"] == "Alex M.")
    assert sam[0].delete(f"/api/splits/{gid}/members/{alex_member}").status_code == 403
    assert jordan.delete(f"/api/splits/{gid}/members/{alex_member}").status_code == 204
    assert alex[0].get("/api/splits").json()["groups"] == []


def test_ledgers_are_opaque_and_versions_only_go_forward() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    blob = b64(b"\x01" + bytes(range(60)))
    r = sam[0].put(f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": blob, "version": 1})
    assert r.status_code == 204
    r = sam[0].put(f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": blob, "version": 1})
    assert r.status_code == 409 and r.json()["detail"] == "stale_version"
    seen = jordan.get(f"/api/splits/{gid}/state").json()["blobs"]
    assert [(b["kind"], b["ciphertext"]) for b in seen] == [("ledger", blob)]


def test_key_handover_never_lets_a_member_swap_someone_elses_key() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    alex = person("Alex M.")
    gid = group_with(jordan, [sam, alex])
    pub = b64(b"public-key-bytes-of-sams-device")
    r = sam[0].put(
        f"/api/splits/{gid}/keys/request", json={"device_key_id": "dev-sam-1", "public_key": pub}
    )
    assert r.status_code == 204
    state = jordan.get(f"/api/splits/{gid}/state").json()
    sam_member = state["keys"][0]["member_id"]
    path = f"/api/splits/{gid}/keys/{sam_member}/dev-sam-1"
    assert jordan.put(path, json={"wrapped_key": b64(b"wrapped-by-jordan")}).status_code == 204
    assert alex[0].put(path, json={"wrapped_key": b64(b"wrapped-by-alex")}).status_code == 204
    mine = sam[0].get(f"/api/splits/{gid}/state").json()["keys"][0]
    assert mine["wrapped_key"] == b64(b"wrapped-by-jordan")  # the first wrap wins
    # Nobody else is handed Sam's wrapped key
    assert jordan.get(f"/api/splits/{gid}/state").json()["keys"][0]["wrapped_key"] is None


def test_the_pay_warning_keeps_its_version_and_time_only() -> None:
    sam_client, sam_id, _ = person("Sam L.")
    r = sam_client.post("/api/splits/pay-consent", json={"version": "2026-11-08"})
    assert r.status_code == 204
    r = sam_client.post("/api/splits/pay-consent", json={"version": "2026-01-01"})
    assert r.status_code == 409 and r.json()["detail"] == "warning_changed"
    with get_session_factory()() as db:
        rows = db.scalars(
            select(SplitPayConsent).where(SplitPayConsent.user_id == uuid.UUID(sam_id))
        ).all()
    assert [r.version for r in rows] == ["2026-11-08"]


def test_deleting_an_account_leaves_its_groups_and_keeps_the_bills() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    bill = sam[0].post(f"/api/splits/{gid}/bills").json()["id"]
    r = sam[0].post("/api/account/delete", json={"confirm": "DELETE"})
    assert r.status_code == 204, r.text
    group = jordan.get("/api/splits").json()["groups"][0]
    assert [m["display_name"] for m in group["members"]] == ["Jordan K."]
    assert jordan.get(f"/api/splits/{gid}/state").json()["bill_ids"] == [bill]
    with get_session_factory()() as db:
        assert db.get(SplitBill, uuid.UUID(bill)) is not None
        assert db.scalar(select(User.split_blocked_at).limit(1)) is None


def _alerts_for(user_id: str) -> list[tuple[str, str, str]]:
    from app.models.notification import AlertSchedule

    with get_session_factory()() as db:
        rows = db.scalars(
            select(AlertSchedule)
            .where(AlertSchedule.user_id == uuid.UUID(user_id))
            .order_by(AlertSchedule.created_at)
        ).all()
    return [(r.type, r.dedupe_key.split(":")[1], r.generic_label) for r in rows]


def test_split_pushes_carry_fixed_words_and_remind_is_once_a_day() -> None:
    jordan, jordan_id, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    # Sam joining tells Jordan, whose app hands Sam's device the key
    assert _alerts_for(jordan_id) == [
        ("split_activity", "join", "Someone joined your group. Open Qash to let them in.")
    ]
    bill = jordan.post(f"/api/splits/{gid}/bills").json()["id"]
    assert _alerts_for(sam[1])[-1] == ("split_activity", "bill", "Someone added a bill to a group.")
    sam[0].post(f"/api/splits/{gid}/disputes", json={"bill_id": bill})
    assert _alerts_for(jordan_id)[-1][1] == "dispute"

    sam_member = next(
        m["member_id"]
        for m in jordan.get("/api/splits").json()["groups"][0]["members"]
        if m["display_name"] == "Sam L."
    )
    for _ in range(3):
        r = jordan.post(f"/api/splits/{gid}/remind", json={"member_id": sam_member})
        assert r.status_code == 204
    reminders = [a for a in _alerts_for(sam[1]) if a[1] == "remind"]
    assert reminders == [("split_activity", "remind", "You have a balance in a group.")]
    for kind, _, label in _alerts_for(sam[1]) + _alerts_for(jordan_id):
        assert "Jordan" not in label and "Sam" not in label and "$" not in label, (kind, label)


def test_a_blocked_organizer_cant_remind() -> None:
    jordan, jordan_id, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    with get_session_factory()() as db, db.begin():
        db.execute(
            update(User)
            .where(User.id == uuid.UUID(jordan_id))
            .values(split_blocked_at=datetime.now(UTC))
        )
    group = sam[0].get("/api/splits").json()["groups"][0]
    assert group["reported"] is True
    sam_member = group["my_member_id"]
    r = jordan.post(f"/api/splits/{gid}/remind", json={"member_id": sam_member})
    assert r.status_code == 403 and r.json()["detail"] == "split_blocked"
