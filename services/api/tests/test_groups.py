"""The monthly savings challenge, end to end: create, look up, join, post a percentage, see the
members, leave, rejoin, owner removes a member and regenerates the code. Only percentages and
display names ever appear in a response."""

import re
import uuid

import pytest
from fastapi.testclient import TestClient

from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator

CODE = re.compile(r"^STK-[A-HJ-NP-Z2-9]{4}$")


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def member(name: str) -> tuple[TestClient, str]:
    client = new_client()
    sign_up(
        client, f"{name.split()[0].lower()}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator()
    )
    r = client.patch("/api/account", json={"display_name": name})
    assert r.status_code == 200, r.text
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    grant_plan(user_id, "private")  # Private: can create and join without limits
    return client, user_id


def test_display_name_round_trips() -> None:
    client, _ = member("Maya R.")
    assert client.get("/api/account").json() == {
        "email": client.get("/api/auth/session").json()["user"]["email"],
        "display_name": "Maya R.",
        "look": "modern",
    }
    assert client.get("/api/auth/session").json()["user"]["display_name"] == "Maya R."
    assert client.patch("/api/account", json={"display_name": "   "}).status_code == 422
    assert client.patch("/api/account", json={"display_name": "x" * 41}).status_code == 422


def test_monthly_savings_challenge() -> None:
    maya, maya_id = member("Maya R.")
    dev, dev_id = member("Dev P.")
    sam, sam_id = member("Sam K.")

    r = maya.post("/api/groups", json={"name": "  October savings ", "month": "2026-10"})
    assert r.status_code == 201, r.text
    group = r.json()
    gid, code = group["id"], group["invite_code"]
    assert CODE.fullmatch(code), code
    assert (group["start_date"], group["end_date"]) == ("2026-10-01", "2026-10-31")
    assert group["name"] == "October savings"
    assert group["is_owner"] is True and group["member_count"] == 1
    assert [m["display_name"] for m in group["members"]] == ["Maya R."]
    assert group["members"][0]["has_events"] is False

    # Looking up a code shows the group, never its members' numbers; lower case and spaces are fine
    r = dev.post("/api/groups/lookup", json={"code": f" {code.lower()} "})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "id": gid,
        "name": "October savings",
        "template_key": "monthly_savings",
        "started_by": "Maya R.",
        "start_date": "2026-10-01",
        "end_date": "2026-10-31",
        "member_count": 1,
        "already_member": False,
    }
    assert dev.post("/api/groups/lookup", json={"code": "STK-ZZZZ"}).status_code == 404
    assert dev.post("/api/groups/lookup", json={"code": "nope"}).status_code == 404

    assert dev.post("/api/groups/join", json={"code": code}).status_code == 200
    r = sam.post("/api/groups/join", json={"code": code})
    assert r.status_code == 200 and r.json()["member_count"] == 3
    # joining twice is a no-op
    assert dev.post("/api/groups/join", json={"code": code}).json()["member_count"] == 3

    # Progress is one percentage per member
    assert maya.put(f"/api/groups/{gid}/progress", json={"progress_bps": 8600}).status_code == 200
    r = dev.put(f"/api/groups/{gid}/progress", json={"progress_bps": 6400})
    assert r.status_code == 200 and r.json()["has_events"] is True
    assert dev.put(f"/api/groups/{gid}/progress", json={"progress_bps": -1}).status_code == 422

    r = sam.get(f"/api/groups/{gid}")
    assert r.status_code == 200, r.text
    detail = r.json()
    assert "cents" not in r.text and "@" not in r.text  # no amounts, no emails
    by_name = {m["display_name"]: m for m in detail["members"]}
    assert by_name["Maya R."]["progress_bps"] == 8600 and by_name["Maya R."]["is_owner"] is True
    assert by_name["Dev P."]["progress_bps"] == 6400 and by_name["Dev P."]["initial"] == "D"
    assert by_name["Sam K."]["has_events"] is False and by_name["Sam K."]["is_me"] is True
    assert detail["my_progress_bps"] == 0 and detail["is_owner"] is False

    # Reaching 100% stamps the time once; dropping below keeps it (the rank tie-break)
    r = dev.put(f"/api/groups/{gid}/progress", json={"progress_bps": 10000})
    reached = r.json()["reached_at"]
    assert re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", reached)
    r = dev.put(f"/api/groups/{gid}/progress", json={"progress_bps": 9000})
    assert r.json()["reached_at"] == reached

    r = maya.get("/api/groups")
    assert [g["id"] for g in r.json()] == [gid]
    assert r.json()[0]["my_progress_bps"] == 8600

    # Leaving and rejoining
    assert sam.post(f"/api/groups/{gid}/leave").status_code == 204
    assert sam.get(f"/api/groups/{gid}").status_code == 404
    assert sam.get("/api/groups").json() == []
    assert maya.get(f"/api/groups/{gid}").json()["member_count"] == 2
    assert sam.post("/api/groups/join", json={"code": code}).json()["member_count"] == 3
    assert maya.post(f"/api/groups/{gid}/leave").status_code == 409  # owner keeps the group

    # Owner-only actions
    assert sam.delete(f"/api/groups/{gid}/members/{dev_id}").status_code == 403
    assert sam.post(f"/api/groups/{gid}/code").status_code == 403
    assert maya.delete(f"/api/groups/{gid}/members/{dev_id}").status_code == 204
    assert dev.get(f"/api/groups/{gid}").status_code == 404
    assert maya.delete(f"/api/groups/{gid}/members/{dev_id}").status_code == 404
    assert maya.delete(f"/api/groups/{gid}/members/{maya_id}").status_code == 409
    r = maya.post(f"/api/groups/{gid}/code")
    assert r.status_code == 200 and r.json()["invite_code"] != code
    assert dev.post("/api/groups/lookup", json={"code": code}).status_code == 404
    r = dev.post("/api/groups/lookup", json={"code": r.json()["invite_code"]})
    assert r.status_code == 200 and r.json()["member_count"] == 2


def test_other_challenge_types_take_their_own_dates() -> None:
    maya, _ = member("Maya R.")
    today = __import__("datetime").date.today()
    week = maya.post(
        "/api/groups",
        json={"name": "", "template_key": "no_eat_out_week", "start_date": today.isoformat()},
    )
    assert week.status_code == 201, week.text
    assert (
        week.json()["name"] == "No-Eat-Out Week"
        and week.json()["template_key"] == "no_eat_out_week"
    )
    start, end = week.json()["start_date"], week.json()["end_date"]
    assert (
        __import__("datetime").date.fromisoformat(end)
        - __import__("datetime").date.fromisoformat(start)
    ).days == 6
    weekend = maya.post(
        "/api/groups",
        json={
            "name": "Quiet weekend",
            "template_key": "no_spend_weekend",
            "start_date": today.isoformat(),
        },
    ).json()
    assert (
        __import__("datetime").date.fromisoformat(weekend["end_date"])
        - __import__("datetime").date.fromisoformat(weekend["start_date"])
    ).days == 1
    year = maya.post(
        "/api/groups",
        json={
            "name": "52 weeks",
            "template_key": "fifty_two_week",
            "start_date": today.isoformat(),
        },
    ).json()
    assert (
        __import__("datetime").date.fromisoformat(year["end_date"])
        - __import__("datetime").date.fromisoformat(year["start_date"])
    ).days == 363
    diet = maya.post(
        "/api/groups",
        json={"name": "Dining diet", "template_key": "dining_diet", "month": "2026-10"},
    ).json()
    assert (diet["start_date"], diet["end_date"]) == ("2026-10-01", "2026-10-31")
    # Lookups carry the type so the joiner's device builds the right local goal
    assert (
        maya.post("/api/groups/lookup", json={"code": diet["invite_code"]}).json()["template_key"]
        == "dining_diet"
    )
    # Missing or out-of-range dates are refused
    assert (
        maya.post("/api/groups", json={"name": "x", "template_key": "no_eat_out_week"}).status_code
        == 422
    )
    assert (
        maya.post("/api/groups", json={"name": "x", "template_key": "dining_diet"}).status_code
        == 422
    )
    far = (today + __import__("datetime").timedelta(days=60)).isoformat()
    assert (
        maya.post(
            "/api/groups", json={"name": "x", "template_key": "no_eat_out_week", "start_date": far}
        ).status_code
        == 422
    )
    assert (
        maya.post(
            "/api/groups", json={"name": "x", "template_key": "lottery", "month": "2026-10"}
        ).status_code
        == 422
    )
