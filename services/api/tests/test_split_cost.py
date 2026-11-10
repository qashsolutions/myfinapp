"""Opening split groups costs the same queries however many people are in them (invariant 81;
load test, November 9, 2026: one 10-person group's list was 109-124 queries, a plan lookup per
member, and 5,000 people at once stalled the API)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.household import Household, HouseholdMember
from app.models.user import User
from app.rules_server import entitlements
from tests.test_request_cost import counted
from tests.test_splits import group_with, invite_token, person


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _list_cost(client) -> int:
    with counted() as seen:
        r = client.get("/api/splits")
    assert r.status_code == 200, r.text
    return len(seen)


def test_the_list_costs_the_same_for_4_people_or_11() -> None:
    # Each group: an organizer, guests, and one person on a plan of their own (a full member),
    # whose plan is the only one the list still asks the rule for.
    small_org, _, _ = person("Ana B.", "connected")
    small = [person(f"Guest{i} S.") for i in range(2)]
    small.append(person("Payer S.", "private"))
    group_with(small_org, small)
    big_org, _, _ = person("Jordan K.", "connected")
    big = [person(f"Guest{i} B.") for i in range(9)]
    big.append(person("Payer B.", "private"))  # a full member on a plan of their own
    big_gid = group_with(big_org, big[:9])
    # The person on a plan of their own joins too: 11 in all.
    token = invite_token(big_org, big_gid, big[9][2])
    assert big[9][0].post("/api/splits/invites/accept", json={"token": token}).status_code == 200

    assert _list_cost(big_org) == _list_cost(small_org)
    assert _list_cost(big[0][0]) == _list_cost(small[0][0])
    # What the list says is unchanged: the guests are guests, the payer is not, nor the organizer.
    group = big_org.get("/api/splits").json()["groups"][0]
    shown = {m["display_name"]: m["guest"] for m in group["members"]}
    assert shown["Jordan K."] is False and shown["Payer B."] is False
    assert all(shown[f"Guest{i} B."] for i in range(9))


def test_may_have_plan_never_says_no_to_someone_with_a_plan() -> None:
    """The batch pre-check is generous: anyone the plan rule gives a plan, it flags."""
    cases = {
        "free": person("Free F.")[1],
        "paid": person("Paid P.", "connected")[1],
        "trial": person("Trial T.")[1],
        "covered": person("Covered C.")[1],
        "holder": person("Holder H.", "connected")[1],
    }
    now = datetime.now(UTC)
    with get_session_factory()() as db, db.begin():
        trial = db.get(User, uuid.UUID(cases["trial"]))
        trial.trial_plan, trial.trial_ends_at = "private", now + timedelta(days=2)
        hh = Household(owner_id=uuid.UUID(cases["holder"]))
        db.add(hh)
        db.flush()
        for uid in (cases["holder"], cases["covered"]):
            db.add(HouseholdMember(household_id=hh.id, user_id=uuid.UUID(uid), joined_at=now))
    with get_session_factory()() as db:
        ids = [uuid.UUID(u) for u in cases.values()]
        users = list(db.scalars(select(User).where(User.id.in_(ids))))
        maybe = entitlements.may_have_plan(db, users, now=now)
        for user in users:
            plan = entitlements.effective_plan(db, user.id)[0]
            if plan != "free":
                assert user.id in maybe, (user.display_name, plan)
        assert uuid.UUID(cases["free"]) not in maybe
        assert entitlements.effective_plan(db, uuid.UUID(cases["covered"]))[0] != "free"
