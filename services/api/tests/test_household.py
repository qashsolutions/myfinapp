"""A household of two: invite, look up, join, share ciphertext, leave. The server never sees a
key, a jar's amount or an entry; it keeps membership, a code and opaque blobs."""

import base64
import os
import re
import uuid

import pytest

from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator

CODE = re.compile(r"^HH-[A-HJ-NP-Z2-9]{6}$")


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def member(name: str, plan: str | None):
    client = new_client()
    sign_up(
        client, f"{name.split()[0].lower()}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator()
    )
    client.patch("/api/account", json={"display_name": name})
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    if plan:
        grant_plan(user_id, plan)
    return client, user_id


def test_invite_join_share_leave() -> None:
    maya, maya_id = member("Maya R.", "connected")
    dev, dev_id = member("Dev P.", None)
    sam, _ = member("Sam K.", None)

    assert maya.get("/api/household").json() == {"household": None, "available": True}
    assert dev.get("/api/household").json()["available"] is False
    r = dev.post("/api/household/invites")
    assert r.status_code == 403 and r.json()["detail"] == "plan_required"

    r = maya.post("/api/household/invites")
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    assert CODE.fullmatch(code), code
    mine = maya.get("/api/household").json()["household"]
    assert mine["owner_id"] == maya_id and [m["display_name"] for m in mine["members"]] == [
        "Maya R."
    ]
    assert mine["invite"]["code"] == code
    # A new invite replaces the old code
    code2 = maya.post("/api/household/invites").json()["code"]
    assert code2 != code
    assert dev.post("/api/household/lookup", json={"code": code}).status_code == 404

    r = dev.post("/api/household/lookup", json={"code": f" {code2.lower()} "})
    assert r.status_code == 200, r.text
    assert r.json()["invited_by"] == "Maya R." and r.json()["initial"] == "M"

    r = dev.post("/api/household/join", json={"code": code2})
    assert r.status_code == 200, r.text
    joined = r.json()
    assert [m["display_name"] for m in joined["members"]] == ["Maya R.", "Dev P."]
    assert [m["is_me"] for m in joined["members"]] == [False, True]
    assert joined["invite"] is None
    assert dev.get("/api/household").json()["household"]["id"] == mine["id"]

    # Used codes stop working; a full household issues no more invites; one household each
    assert sam.post("/api/household/join", json={"code": code2}).status_code == 404
    r = maya.post("/api/household/invites")
    assert r.status_code == 409 and r.json()["detail"] == "household_full"
    r = dev.post("/api/household/join", json={"code": code2})
    assert r.status_code == 409 and r.json()["detail"] == "already_in_household"

    # Shared data is ciphertext per author and kind; the partner's plan covers the household
    jars = b64(os.urandom(200))
    r = dev.put("/api/household/blobs/jars", json={"ciphertext": jars, "version": 1})
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "jars" and r.json()["version"] == 1
    r = maya.get("/api/household/blobs")
    assert r.status_code == 200
    assert [(b["author_id"], b["kind"], b["ciphertext"], b["version"]) for b in r.json()] == [
        (dev_id, "jars", jars, 1)
    ]
    jars2 = b64(os.urandom(220))
    assert (
        dev.put("/api/household/blobs/jars", json={"ciphertext": jars2, "version": 2}).status_code
        == 200
    )
    assert (
        maya.put(
            "/api/household/blobs/summary", json={"ciphertext": b64(b"m"), "version": 1}
        ).status_code
        == 200
    )
    blobs = maya.get("/api/household/blobs").json()
    assert sorted((b["kind"], b["version"]) for b in blobs) == [("jars", 2), ("summary", 1)]
    assert (
        dev.put("/api/household/blobs/photos", json={"ciphertext": jars, "version": 1}).status_code
        == 422
    )
    assert sam.get("/api/household/blobs").status_code == 404
    assert (
        sam.put("/api/household/blobs/jars", json={"ciphertext": jars, "version": 1}).status_code
        == 404
    )
    assert "cents" not in maya.get("/api/household").text

    # Leaving: the leaver's blobs go, the other keeps the household; the last one out removes it
    assert dev.post("/api/household/leave").status_code == 204
    assert dev.get("/api/household").json()["household"] is None
    left = maya.get("/api/household").json()["household"]
    assert [m["display_name"] for m in left["members"]] == ["Maya R."]
    assert [b["kind"] for b in maya.get("/api/household/blobs").json()] == ["summary"]
    assert dev.post("/api/household/leave").status_code == 404
    assert maya.post("/api/household/leave").status_code == 204
    assert maya.get("/api/household").json()["household"] is None
    assert maya.get("/api/household/blobs").status_code == 404


def test_account_deletion_leaves_the_household() -> None:
    maya, _ = member("Maya R.", "connected")
    dev, _ = member("Dev P.", None)
    code = maya.post("/api/household/invites").json()["code"]
    assert dev.post("/api/household/join", json={"code": code}).status_code == 200
    assert (
        dev.put(
            "/api/household/blobs/jars", json={"ciphertext": b64(b"d"), "version": 1}
        ).status_code
        == 200
    )
    assert dev.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    left = maya.get("/api/household").json()["household"]
    assert [m["display_name"] for m in left["members"]] == ["Maya R."]
    assert maya.get("/api/household/blobs").json() == []


def _pair(partner_plan: str | None):
    maya, maya_id = member("Maya R.", "connected")
    dev, dev_id = member("Dev P.", partner_plan)
    code = maya.post("/api/household/invites").json()["code"]
    assert dev.post("/api/household/join", json={"code": code}).status_code == 200
    return maya, maya_id, dev, dev_id


def test_when_the_owner_leaves_the_partner_owns_the_household_on_their_own_plan() -> None:
    """Like a challenge (groups pass to the longest-standing member), the household passes to
    the partner, and from then on its writes ride the partner's plan, never the plan of
    someone who left (spec: "a partner on any plan joins under the Connected owner's plan")."""
    maya, _, dev, dev_id = _pair(None)
    assert maya.post("/api/household/leave").status_code == 204
    mine = dev.get("/api/household").json()["household"]
    assert mine["owner_id"] == dev_id
    assert [m["display_name"] for m in mine["members"]] == ["Dev P."]
    blob = {"ciphertext": b64(b"d"), "version": 1}
    r = dev.put("/api/household/blobs/jars", json=blob)
    assert r.status_code == 403 and r.json()["detail"] == "plan_required"


def test_a_partner_on_connected_keeps_sharing_after_the_owner_leaves() -> None:
    maya, _, dev, dev_id = _pair("connected")
    assert maya.post("/api/household/leave").status_code == 204
    blob = {"ciphertext": b64(b"d"), "version": 1}
    assert dev.put("/api/household/blobs/jars", json=blob).status_code == 200
    assert dev.post("/api/household/invites").status_code == 201  # and can invite someone new


def test_an_owner_deleting_their_account_passes_the_household_on() -> None:
    maya, _, dev, dev_id = _pair(None)
    assert maya.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert dev.get("/api/household").json()["household"]["owner_id"] == dev_id
    blob = {"ciphertext": b64(b"d"), "version": 1}
    assert dev.put("/api/household/blobs/jars", json=blob).status_code == 403


def test_two_joins_at_once_still_make_a_household_of_two() -> None:
    """Two connections: another join holds the household (as one in flight does) and adds its
    member; this join must wait for it and then find the household full."""
    import threading

    from sqlalchemy import func, select

    from app.db import get_session_factory
    from app.models.household import Household, HouseholdMember

    maya, maya_id = member("Maya R.", "connected")
    dev, _ = member("Dev P.", None)
    _, sam_id = member("Sam K.", None)
    code = maya.post("/api/household/invites").json()["code"]
    household_id = uuid.UUID(maya.get("/api/household").json()["household"]["id"])

    answers: list = []
    with get_session_factory()() as other:
        other.execute(select(Household.id).where(Household.id == household_id).with_for_update())
        from datetime import UTC, datetime

        other.add(
            HouseholdMember(
                household_id=household_id, user_id=uuid.UUID(sam_id), joined_at=datetime.now(UTC)
            )
        )
        other.flush()
        worker = threading.Thread(
            target=lambda: answers.append(dev.post("/api/household/join", json={"code": code}))
        )
        worker.start()
        worker.join(timeout=1.5)
        other.commit()
    worker.join(timeout=10)
    [r] = answers
    assert r.status_code == 409 and r.json()["detail"] == "household_full", r.text
    with get_session_factory()() as db:
        active = db.scalar(
            select(func.count())
            .select_from(HouseholdMember)
            .where(HouseholdMember.household_id == household_id, HouseholdMember.left_at.is_(None))
        )
    assert active == 2


def test_one_person_is_in_one_household_at_most() -> None:
    """The database refuses a second live membership, whatever a route does."""
    from datetime import UTC, datetime

    import sqlalchemy.exc

    from app.db import get_session_factory
    from app.models.household import Household, HouseholdMember

    _, maya_id = member("Maya R.", "connected")
    with get_session_factory()() as db:
        homes = [Household(owner_id=uuid.UUID(maya_id)) for _ in range(2)]
        db.add_all(homes)
        db.flush()
        for h in homes:
            db.add(
                HouseholdMember(
                    household_id=h.id, user_id=uuid.UUID(maya_id), joined_at=datetime.now(UTC)
                )
            )
        with pytest.raises(sqlalchemy.exc.IntegrityError):
            db.flush()
        db.rollback()
