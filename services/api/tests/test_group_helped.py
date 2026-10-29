"""'What helped' in challenges: fixed choices only, up to 3, once a member reached their target
or the challenge ended; the group sees totals only, and only from 2 answers; the person's own
answer is in their export; deletion takes it out of the totals."""

import uuid
from datetime import date

import pytest
from sqlalchemy import update

from app.db import get_session_factory
from app.models.group import Group
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def member(name: str):
    client = new_client()
    user_id = sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    client.patch("/api/account", json={"display_name": name})
    grant_plan(user_id, "private")
    return client, user_id


def _group(owner, *others):
    r = owner.post("/api/groups", json={"name": "Savers", "month": "2026-10"})
    assert r.status_code == 201, r.text
    gid, code = r.json()["id"], r.json()["invite_code"]
    for o in others:
        assert o.post("/api/groups/join", json={"code": code}).status_code == 200
    return gid


def test_choices_are_fixed_counted_and_never_attributed() -> None:
    maya, _ = member("maya")
    dev, _ = member("dev")
    sam, _ = member("sam")
    gid = _group(maya, dev, sam)

    detail = maya.get(f"/api/groups/{gid}").json()
    assert detail["helped_open"] is False and detail["helped"] is None
    assert detail["my_helped"] == []
    # Not yet: only after reaching the target (or once the challenge ended)
    r = maya.put(f"/api/groups/{gid}/helped", json={"choices": ["packed_lunch"]})
    assert r.status_code == 409 and r.json()["detail"] == "not_yet"

    for c in (maya, dev):
        assert c.put(f"/api/groups/{gid}/progress", json={"progress_bps": 10000}).status_code == 200
    # Unknown ids, free text and more than three are refused
    for bad in (
        ["packed_lunch", "free text"],
        ["skipped coffee"],
        ["packed_lunch", "cooked_home", "no_spend_days", "shopping_list"],
    ):
        r = maya.put(f"/api/groups/{gid}/helped", json={"choices": bad})
        assert r.status_code == 422, bad

    r = maya.put(f"/api/groups/{gid}/helped", json={"choices": ["packed_lunch", "cooked_home"]})
    assert r.status_code == 200, r.text
    assert r.json()["my_helped"] == ["packed_lunch", "cooked_home"]
    # One answer is never shown: it could only be hers
    assert r.json()["helped"] is None
    assert sam.get(f"/api/groups/{gid}").json()["helped"] is None

    r = dev.put(f"/api/groups/{gid}/helped", json={"choices": ["cooked_home", "packed_lunch"]})
    assert r.status_code == 200
    seen = sam.get(f"/api/groups/{gid}").json()
    assert seen["helped"] == {"answered": 2, "counts": {"packed_lunch": 2, "cooked_home": 2}}
    assert seen["my_helped"] == [] and seen["helped_open"] is False
    # Members never carry anyone's answer
    for m in seen["members"]:
        assert "helped" not in m and "my_helped" not in m

    # Changeable, and [] clears it (totals drop back under the minimum)
    dev.put(f"/api/groups/{gid}/helped", json={"choices": ["waited_a_day"]})
    assert maya.get(f"/api/groups/{gid}").json()["helped"] == {
        "answered": 2,
        "counts": {"packed_lunch": 1, "cooked_home": 1, "waited_a_day": 1},
    }
    dev.put(f"/api/groups/{gid}/helped", json={"choices": []})
    assert maya.get(f"/api/groups/{gid}").json()["helped"] is None

    # The person's own answer is in their export (step-up is fresh after sign-up)
    r = maya.post("/api/account/export")
    assert r.status_code == 200, r.text
    mine = [g for g in r.json()["groups"] if g["id"] == gid]
    assert mine[0]["my_helped"] == ["packed_lunch", "cooked_home"]

    # A deleted account's answer leaves the totals
    dev.put(f"/api/groups/{gid}/helped", json={"choices": ["waited_a_day"]})
    assert maya.get(f"/api/groups/{gid}").json()["helped"]["answered"] == 2
    assert dev.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert maya.get(f"/api/groups/{gid}").json()["helped"] is None


def test_an_ended_challenge_opens_it_for_everyone() -> None:
    maya, _ = member("maya")
    dev, _ = member("dev")
    gid = _group(maya, dev)
    with get_session_factory()() as s, s.begin():
        s.execute(
            update(Group)
            .where(Group.id == uuid.UUID(gid))
            .values(start_date=date(2026, 9, 1), end_date=date(2026, 9, 30))
        )
    assert dev.get(f"/api/groups/{gid}").json()["helped_open"] is True
    r = dev.put(f"/api/groups/{gid}/helped", json={"choices": ["no_spend_days"]})
    assert r.status_code == 200, r.text
