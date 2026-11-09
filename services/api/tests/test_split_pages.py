"""Split bills at scale (chunk S.5, November 9, 2026): a member's ledger in monthly pages, a
device downloads only the blobs it lacks, and how many groups one person can be in.
"""

import base64
from datetime import UTC, datetime

import pytest

from app.routers import splits
from tests.test_splits import group_with, invite_token, person


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    pass


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def this_month() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


def test_a_page_is_its_own_blob_and_only_goes_forward() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    page = f"/api/splits/{gid}/blobs/ledger/{this_month()}"
    assert jordan.put(page, json={"ciphertext": b64(b"p1"), "version": 1}).status_code == 204
    assert jordan.put(page, json={"ciphertext": b64(b"p1b"), "version": 1}).status_code == 409
    assert jordan.put(page, json={"ciphertext": b64(b"p2"), "version": 2}).status_code == 204
    head = f"/api/splits/{gid}/blobs/ledger"
    assert jordan.put(head, json={"ciphertext": b64(b"h"), "version": 1}).status_code == 204
    kinds = {b["kind"] for b in jordan.get(f"/api/splits/{gid}/state").json()["blobs"]}
    assert kinds == {"ledger", f"ledger:{this_month()}"}
    # Each page has the same cap as the ledger did
    big = b64(b"x" * (256 * 1024 + 1))
    assert jordan.put(page, json={"ciphertext": big, "version": 3}).status_code in (413, 422)


def test_a_new_page_only_for_the_month_around_today(monkeypatch: pytest.MonkeyPatch) -> None:
    jordan, _, _ = person("Jordan K.", "private")
    gid = jordan.post("/api/splits").json()["id"]
    blob = {"ciphertext": b64(b"x"), "version": 1}
    # Years back or ahead: refused, so pages grow by one a month at most
    for month in ("2020-01", "2031-06"):
        r = jordan.put(f"/api/splits/{gid}/blobs/ledger/{month}", json=blob)
        assert r.status_code == 409 and r.json()["detail"] == "page_closed"
    # Not a month at all
    for bad in ("2026-13", "2026-1", "x"):
        assert jordan.put(f"/api/splits/{gid}/blobs/ledger/{bad}", json=blob).status_code == 422
    # A page started in its month stays writable after it (an edit to an old bill)
    monkeypatch.setattr(splits, "_now", lambda: datetime(2026, 1, 31, 23, 0, tzinfo=UTC))
    assert jordan.put(f"/api/splits/{gid}/blobs/ledger/2026-02", json=blob).status_code == 204
    assert jordan.put(f"/api/splits/{gid}/blobs/ledger/2025-12", json=blob).status_code == 204
    monkeypatch.undo()
    later = {"ciphertext": b64(b"y"), "version": 2}
    assert jordan.put(f"/api/splits/{gid}/blobs/ledger/2026-02", json=later).status_code == 204


def test_a_device_downloads_only_what_it_lacks() -> None:
    jordan, _, _ = person("Jordan K.", "private")
    sam = person("Sam L.")
    gid = group_with(jordan, [sam])
    page = f"/api/splits/{gid}/blobs/ledger/{this_month()}"
    jordan.put(page, json={"ciphertext": b64(b"j1"), "version": 1})
    sam[0].put(page, json={"ciphertext": b64(b"s1"), "version": 1})
    full = jordan.post(f"/api/splits/{gid}/state", json={"known": {}}).json()
    assert len(full["blobs"]) == 2
    known = {f"{v['member_id']}/{v['kind']}": v["version"] for v in full["versions"]}
    # Nothing changed: versions only
    same = jordan.post(f"/api/splits/{gid}/state", json={"known": known}).json()
    assert same["blobs"] == [] and same["versions"] == full["versions"]
    # Sam writes again: only Sam's page comes back
    sam[0].put(page, json={"ciphertext": b64(b"s2"), "version": 2})
    delta = jordan.post(f"/api/splits/{gid}/state", json={"known": known}).json()
    assert [base64.urlsafe_b64decode(b["ciphertext"] + "==") for b in delta["blobs"]] == [b"s2"]
    # A plain GET still returns everything (older builds)
    assert len(jordan.get(f"/api/splits/{gid}/state").json()["blobs"]) == 2
    # A device can't claim an unbounded list
    huge = {f"{i}/ledger": 1 for i in range(splits.MAX_KNOWN + 1)}
    assert jordan.post(f"/api/splits/{gid}/state", json={"known": huge}).status_code == 422


def test_twenty_groups_organized_at_once() -> None:
    jordan, _, _ = person("Jordan K.", "connected")
    assert splits.config()["groups"]["organize_max"] == 20
    ids = [jordan.post("/api/splits").json()["id"] for _ in range(20)]
    r = jordan.post("/api/splits")
    assert r.status_code == 409 and r.json()["detail"] == "too_many_groups"
    # Leaving one frees its place
    sam = person("Sam L.")
    token = invite_token(jordan, ids[0], sam[2])
    assert sam[0].post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    assert jordan.post(f"/api/splits/{ids[0]}/leave", json={}).status_code == 204
    assert jordan.post("/api/splits").status_code == 201


def test_groups_joined_as_a_guest_have_their_own_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    caps = {**splits.config(), "groups": {"organize_max": 20, "join_max": 2}}
    monkeypatch.setattr(splits, "config", lambda: caps)
    sam = person("Sam L.", "private")
    organizers = [person(f"Org{i} X.", "private") for i in range(3)]
    gids = [o[0].post("/api/splits").json()["id"] for o in organizers]
    for (client, _, _), gid in zip(organizers[:2], gids[:2], strict=True):
        token = invite_token(client, gid, sam[2])
        assert sam[0].post("/api/splits/invites/accept", json={"token": token}).status_code == 200
    token = invite_token(organizers[2][0], gids[2], sam[2])
    r = sam[0].post("/api/splits/invites/accept", json={"token": token})
    assert r.status_code == 409 and r.json()["detail"] == "too_many_groups"
    # Joined groups don't use up the groups Sam can start, and the other way round
    assert sam[0].post("/api/splits").status_code == 201
