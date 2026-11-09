"""Split bills under abuse (November 9, 2026): the server's half of the negative scenarios.

Replayed and cancelled invite links, removed members who come back through the API, guests
reaching for organizer actions, cross-group ids, oversized and out-of-order blobs, spam of
waiting bills, and the bills of people who left staying readable so balances never move.
"""

import base64
import uuid

import pytest

from tests.test_splits import group_with, invite_token, person


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    pass


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def test_an_invite_link_works_once_and_never_after_a_no_or_a_cancel() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam, _, sam_email = person("Sam L.")
    alex, _, alex_email = person("Alex P.")
    gid = jordan.post("/api/splits").json()["id"]
    token = invite_token(jordan, gid, sam_email)
    assert sam.post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    # Replayed after use: gone
    assert sam.post("/api/splits/invites/accept", json={"token": token}).status_code == 404
    assert sam.post("/api/splits/invites/lookup", json={"token": token}).status_code == 404
    # Declined, then tried again: gone
    token = invite_token(jordan, gid, alex_email)
    assert alex.post("/api/splits/invites/decline", json={"token": token}).status_code == 204
    assert alex.post("/api/splits/invites/accept", json={"token": token}).status_code == 404
    # Cancelled by the organizer before it was used: gone
    other, _, other_email = person("Kim T.")
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": other_email})
    jordan.delete(f"/api/splits/{gid}/invites/{r.json()['id']}")
    assert (
        other.post("/api/splits/invites/accept", json={"token": r.json()["token"]}).status_code
        == 404
    )
    # A made-up token: nothing to learn
    fake = "x" * 43
    assert other.post("/api/splits/invites/lookup", json={"token": fake}).status_code == 404


def test_a_removed_member_cant_read_write_or_add_and_their_bills_stay_for_everyone() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    sam_member = next(
        m["member_id"]
        for m in jordan.get("/api/splits").json()["groups"][0]["members"]
        if not m["is_me"]
    )
    assert (
        sam[0]
        .put(f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": b64(b"sam"), "version": 1})
        .status_code
        == 204
    )
    assert jordan.delete(f"/api/splits/{gid}/members/{sam_member}").status_code == 204
    for r in (
        sam[0].get(f"/api/splits/{gid}/state"),
        sam[0].put(
            f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": b64(b"new"), "version": 2}
        ),
        sam[0].post(f"/api/splits/{gid}/bills"),
        sam[0].post(f"/api/splits/{gid}/disputes", json={"bill_id": str(uuid.uuid4())}),
        sam[0].post(f"/api/splits/{gid}/remind", json={"member_id": sam_member}),
    ):
        assert r.status_code == 404, r.text
    # Sam's ledger stays readable to the group, so his bills (and balances) don't move
    blobs = jordan.get(f"/api/splits/{gid}/state").json()["blobs"]
    assert [b["member_id"] for b in blobs if b["kind"] == "ledger"] == [sam_member]
    # And the removed person can't be reminded
    r = jordan.post(f"/api/splits/{gid}/remind", json={"member_id": sam_member})
    assert r.status_code == 404


def test_guests_cant_reach_for_the_organizers_actions() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    alex = person("Alex P.")
    gid = group_with(jordan, [sam, alex])
    members = jordan.get("/api/splits").json()["groups"][0]["members"]
    alex_member = next(m["member_id"] for m in members if m["display_name"] == "Alex P.")
    waiting = alex[0].post(f"/api/splits/{gid}/bills").json()["id"]
    for r in (
        sam[0].post(f"/api/splits/{gid}/bills/{waiting}/approve"),
        sam[0].post(f"/api/splits/{gid}/bills/{waiting}/decline"),
        sam[0].patch(f"/api/splits/{gid}", json={"guests_can_add": False}),
        sam[0].delete(f"/api/splits/{gid}/members/{alex_member}"),
        sam[0].post(f"/api/splits/{gid}/invites", json={"email": "new@example.com"}),
    ):
        assert r.status_code == 403, r.text
    # A guest can't take over while the organizer still runs it
    assert sam[0].post(f"/api/splits/{gid}/takeover").status_code == 409
    # Nor remind themselves
    me = next(
        m["member_id"]
        for m in sam[0].get("/api/splits").json()["groups"][0]["members"]
        if m["is_me"]
    )
    assert sam[0].post(f"/api/splits/{gid}/remind", json={"member_id": me}).status_code == 422


def test_ids_from_another_group_are_not_found() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    mine = group_with(jordan, [sam])
    other_org, _, _ = person("Riley Q.", "private")
    theirs = other_org.post("/api/splits").json()["id"]
    their_bill = other_org.post(f"/api/splits/{theirs}/bills").json()["id"]
    # A bill from someone else's group, used in mine
    assert (
        sam[0].post(f"/api/splits/{mine}/disputes", json={"bill_id": their_bill}).status_code == 404
    )
    assert jordan.post(f"/api/splits/{mine}/bills/{their_bill}/approve").status_code == 404
    # Someone else's group outright
    assert sam[0].get(f"/api/splits/{theirs}/state").status_code == 404
    assert jordan.post(f"/api/splits/{theirs}/bills").status_code == 404


def test_blobs_are_capped_and_never_go_back_a_version() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    big = b64(b"x" * (256 * 1024 + 1))
    assert jordan.put(
        f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": big, "version": 1}
    ).status_code in (413, 422)
    ok = jordan.put(f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": b64(b"a"), "version": 5})
    assert ok.status_code == 204
    for v in (5, 4, 0):
        r = jordan.put(
            f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": b64(b"b"), "version": v}
        )
        assert r.status_code in (409, 422), (v, r.text)
    # Not base64url: refused before it is stored
    r = jordan.put(f"/api/splits/{gid}/blobs/ledger", json={"ciphertext": "<script>", "version": 6})
    assert r.status_code == 422


def test_a_guest_cant_flood_the_organizer_with_waiting_bills() -> None:
    jordan, _, _ = person("Jordan K.", "private")  # 6 a day
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    for _ in range(6):
        assert sam[0].post(f"/api/splits/{gid}/bills").status_code == 201
    r = sam[0].post(f"/api/splits/{gid}/bills")
    assert r.status_code == 429 and r.json()["detail"] == "daily_limit"
    # Approving one frees a place
    waiting = jordan.get(f"/api/splits/{gid}/state").json()["pending"][0]["bill_id"]
    assert jordan.post(f"/api/splits/{gid}/bills/{waiting}/approve").status_code == 200
    assert sam[0].post(f"/api/splits/{gid}/bills").status_code == 201


def test_the_people_limit_counts_pending_invites_too() -> None:
    jordan, _, _ = person("Jordan K.", "private")  # 6 people
    gid = jordan.post("/api/splits").json()["id"]
    for n in range(5):
        r = jordan.post(
            f"/api/splits/{gid}/invites", json={"email": f"p{n}-{uuid.uuid4().hex[:4]}@example.com"}
        )
        assert r.status_code == 201
    r = jordan.post(f"/api/splits/{gid}/invites", json={"email": "one-too-many@example.com"})
    assert r.status_code == 403 and r.json()["detail"] == "plan_limit"
