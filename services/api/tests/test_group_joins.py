"""Invariants 45 and 46 (October 29, 2026): joining a challenge.

45. Someone the owner removed stays out: neither the old code nor the current one lets them back
    (403 `removed`, said plainly in the app). Someone who left on their own may come back.
46. A join counts and writes under a lock on the person, then the group: two joins at once
    can't both pass Free's one challenge, and two joins of the same group at once answer the
    same membership (200 both), never a 500 from the unique constraint.

The concurrent cases send the requests in parallel from separate clients (separate database
sessions) against the real Postgres, with the gap between the count and the write widened as
a busy server would, so they overlap every time."""

from __future__ import annotations

import threading
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db import get_session_factory
from app.models.group_member import GroupMember
from app.routers import groups as groups_router
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def person(name: str, plan: str | None = "private") -> tuple[TestClient, str]:
    client = new_client()
    sign_up(client, f"{name.lower()}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    assert client.patch("/api/account", json={"display_name": name}).status_code == 200
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    if plan:
        grant_plan(user_id, plan)
    return client, user_id


def twin(client: TestClient) -> TestClient:
    """A second client with the same session cookie (one person, two requests at once)."""
    other = new_client()
    other.cookies.update(client.cookies)
    return other


def new_group(owner: TestClient, month: str = "2026-11") -> tuple[str, str]:
    r = owner.post("/api/groups", json={"name": "Savers", "month": month})
    assert r.status_code == 201, r.text
    return r.json()["id"], r.json()["invite_code"]


def in_parallel(calls) -> list:
    barrier = threading.Barrier(len(calls))
    out: list = [None] * len(calls)

    def run(i: int) -> None:
        barrier.wait()
        out[i] = calls[i]()

    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(calls))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return out


@pytest.fixture
def slow_membership(monkeypatch: pytest.MonkeyPatch) -> None:
    """Widen the gap between reading the person's memberships and writing the new one."""
    real = groups_router._membership

    def slow(db, group, user_id):
        found = real(db, group, user_id)
        time.sleep(0.15)
        return found

    monkeypatch.setattr(groups_router, "_membership", slow)


def test_a_removed_member_cannot_rejoin_with_any_code() -> None:
    owner, _ = person("Maya")
    dev, dev_id = person("Dev")
    gid, code = new_group(owner)
    assert dev.post("/api/groups/join", json={"code": code}).status_code == 200
    assert owner.delete(f"/api/groups/{gid}/members/{dev_id}").status_code == 204

    for attempt in ("lookup", "join"):
        r = dev.post(f"/api/groups/{attempt}", json={"code": code})
        assert r.status_code == 403 and r.json()["detail"] == "removed", (attempt, r.text)
    new_code = owner.post(f"/api/groups/{gid}/code").json()["invite_code"]
    assert new_code != code
    for attempt in ("lookup", "join"):
        r = dev.post(f"/api/groups/{attempt}", json={"code": new_code})
        assert r.status_code == 403 and r.json()["detail"] == "removed", (attempt, r.text)
    assert dev.get(f"/api/groups/{gid}").status_code == 404
    assert owner.get(f"/api/groups/{gid}").json()["member_count"] == 1


def test_a_member_who_left_can_come_back() -> None:
    owner, _ = person("Maya")
    sam, _ = person("Sam")
    gid, code = new_group(owner)
    assert sam.post("/api/groups/join", json={"code": code}).status_code == 200
    assert sam.post(f"/api/groups/{gid}/leave").status_code == 204
    assert sam.post("/api/groups/lookup", json={"code": code}).json()["already_member"] is False
    r = sam.post("/api/groups/join", json={"code": code})
    assert r.status_code == 200 and r.json()["member_count"] == 2


def test_two_joins_at_once_cannot_pass_free_s_one_challenge(slow_membership) -> None:
    a, _ = person("Ana")
    b, _ = person("Ben")
    _, code_a = new_group(a)
    _, code_b = new_group(b)
    free, free_id = person("Fay", plan=None)
    other = twin(free)
    results = in_parallel(
        [
            lambda: free.post("/api/groups/join", json={"code": code_a}),
            lambda: other.post("/api/groups/join", json={"code": code_b}),
        ]
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 403], [r.text for r in results]
    refused = next(r for r in results if r.status_code == 403)
    assert refused.json()["detail"] == "plan_limit"
    with get_session_factory()() as s:
        active = s.scalar(
            select(func.count())
            .select_from(GroupMember)
            .where(GroupMember.user_id == uuid.UUID(free_id), GroupMember.left_at.is_(None))
        )
    assert active == 1


def test_two_joins_of_one_group_at_once_answer_the_same_membership(slow_membership) -> None:
    owner, _ = person("Maya")
    gid, code = new_group(owner)
    dev, dev_id = person("Dev")
    other = twin(dev)
    results = in_parallel(
        [
            lambda: dev.post("/api/groups/join", json={"code": code}),
            lambda: other.post("/api/groups/join", json={"code": code}),
        ]
    )
    assert [r.status_code for r in results] == [200, 200], [r.text for r in results]
    assert {r.json()["id"] for r in results} == {gid}
    assert all(r.json()["member_count"] == 2 for r in results)
    with get_session_factory()() as s:
        rows = s.scalars(select(GroupMember).where(GroupMember.user_id == uuid.UUID(dev_id))).all()
    assert len(rows) == 1


def test_rejoining_after_leaving_at_once_from_two_requests(slow_membership) -> None:
    """The reopen path takes the same locks: two rejoins of one left membership both answer it."""
    owner, _ = person("Maya")
    gid, code = new_group(owner)
    sam, _ = person("Sam")
    assert sam.post("/api/groups/join", json={"code": code}).status_code == 200
    assert sam.post(f"/api/groups/{gid}/leave").status_code == 204
    other = twin(sam)
    results = in_parallel(
        [
            lambda: sam.post("/api/groups/join", json={"code": code}),
            lambda: other.post("/api/groups/join", json={"code": code}),
        ]
    )
    assert [r.status_code for r in results] == [200, 200], [r.text for r in results]
    assert owner.get(f"/api/groups/{gid}").json()["member_count"] == 2
