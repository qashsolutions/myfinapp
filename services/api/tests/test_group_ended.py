"""Invariant 56 (October 29, 2026): an ended challenge is over. Before, a challenge past its
last day could still be looked up and joined ("Your target this month"), since the join route
never read its end date. Every type has one: the month, the week, the weekend, the 52 weeks."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from app.db import get_session_factory
from app.models.group import Group
from app.routers import groups as groups_router
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def person(name: str):
    client = new_client()
    sign_up(client, f"{name.lower()}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    client.patch("/api/account", json={"display_name": name})
    grant_plan(client.get("/api/auth/session").json()["user"]["id"], "private")
    return client


def end_on(group_id: str, day: date) -> None:
    with get_session_factory()() as db:
        group = db.get(Group, uuid.UUID(group_id))
        assert group is not None
        group.end_date = day
        db.commit()


def test_an_ended_challenge_cannot_be_looked_up_or_joined_but_members_keep_the_board() -> None:
    owner, friend, late = person("Owner"), person("Friend"), person("Late")
    r = owner.post("/api/groups", json={"name": "Savers", "month": "2026-11"})
    group_id, code = r.json()["id"], r.json()["invite_code"]
    assert friend.post("/api/groups/join", json={"code": code}).status_code == 200
    end_on(group_id, datetime.now(UTC).date() - timedelta(days=2))
    for call in ("/api/groups/lookup", "/api/groups/join"):
        r = late.post(call, json={"code": code})
        assert r.status_code == 409 and r.json()["detail"] == "ended", call
    # Members still see the final board, and joining again answers the same membership.
    assert friend.get(f"/api/groups/{group_id}").status_code == 200
    assert friend.post("/api/groups/join", json={"code": code}).status_code == 200
    # Someone who left can't come back into an ended challenge either.
    assert friend.post(f"/api/groups/{group_id}/leave").status_code == 204
    assert friend.post("/api/groups/join", json={"code": code}).json()["detail"] == "ended"


def test_the_last_day_stays_open_until_it_is_over_everywhere() -> None:
    owner, late = person("Owner"), person("Late")
    r = owner.post("/api/groups", json={"name": "Savers", "month": "2026-11"})
    group_id, code = r.json()["id"], r.json()["invite_code"]
    today = datetime.now(UTC).date()
    end_on(group_id, today)
    assert late.post("/api/groups/lookup", json={"code": code}).status_code == 200


@pytest.mark.parametrize(
    ("template", "body", "days"),
    [
        ("monthly_savings", {"month": "2026-11"}, 29),
        ("dining_diet", {"month": "2026-11"}, 29),
        ("no_eat_out_week", {}, 6),
        ("no_spend_weekend", {}, 1),
        ("fifty_two_week", {}, 52 * 7 - 1),
    ],
)
def test_every_type_ends_and_closes_on_its_last_day(template: str, body: dict, days: int) -> None:
    owner = person("Owner")
    start = datetime.now(UTC).date()
    payload = {"name": "", "template_key": template, **body}
    if "month" not in body:
        payload["start_date"] = start.isoformat()
    r = owner.post("/api/groups", json=payload)
    assert r.status_code == 201, r.text
    got = r.json()
    first = date.fromisoformat(got["start_date"])
    last = date.fromisoformat(got["end_date"])
    assert (last - first).days == days
    with get_session_factory()() as db:
        group = db.get(Group, uuid.UUID(got["id"]))
        assert group is not None
        noon_after = datetime.combine(last + timedelta(days=1), datetime.min.time(), tzinfo=UTC)
        assert not groups_router._ended(group, noon_after + timedelta(hours=11, minutes=59))
        assert groups_router._ended(group, noon_after + timedelta(hours=12))
