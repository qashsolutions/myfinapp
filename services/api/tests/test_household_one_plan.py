"""A household of two is one plan (owner decision, October 29, 2026; invariant 54): "partner and
owner use the same account for one price. if one of them ends, both of them lose. we do have to
give them a notice period and send a mail."

The defect (October 29, 2026 test): Ben joined Asha's Connected household during his own trial;
his trial ran out, so he was locked out on day 4 and his account closed on day 10, and Asha's
shared jar lost his deposits, while Asha's plan was paying for both of them."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs import plan_lifecycle
from app.models.billing import Entitlement, Subscription
from app.models.household import HouseholdMember
from app.models.user import User
from app.rules_server.entitlements import store_entitlements
from app.services import stripe_billing
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import PLACEHOLDER_CONSENT, grant_plan
from tests.conftest import stripe_default_transport
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


def person(name: str):
    client = new_client()
    email = f"{name.lower()}-{uuid.uuid4().hex[:8]}@example.com"
    sign_up(client, email, FakeAuthenticator())
    client.patch("/api/account", json={"display_name": name})
    user_id = uuid.UUID(client.get("/api/auth/session").json()["user"]["id"])
    return client, user_id, email


def access(client) -> dict:
    return client.get("/api/billing/entitlements").json()["access"]


def set_user(user_id: uuid.UUID, **fields) -> None:
    with get_session_factory()() as db:
        user = db.get(User, user_id)
        assert user is not None
        for k, v in fields.items():
            setattr(user, k, v)
        db.commit()


def set_subscription(user_id: uuid.UUID, **fields) -> None:
    with get_session_factory()() as db:
        sub = db.scalar(select(Subscription).where(Subscription.user_id == user_id))
        assert sub is not None
        for k, v in fields.items():
            setattr(sub, k, v)
        db.commit()


def run(now: datetime, *ids: uuid.UUID) -> dict[str, int]:
    with get_session_factory()() as db:
        return plan_lifecycle.run(db, now=now, only=set(ids))


def household(owner, partner, *, days_ago: int = 30) -> None:
    """The two make a household. Its joins are dated `days_ago`, as if it had been formed
    then: the tests move plan ends into the past, and only an end after the household became
    two is the household's (invariant 54)."""
    code = owner.post("/api/household/invites").json()["code"]
    r = partner.post("/api/household/join", json={"code": code})
    assert r.status_code == 200, r.text
    ids = [uuid.UUID(c.get("/api/auth/session").json()["user"]["id"]) for c in (owner, partner)]
    with get_session_factory()() as db:
        for m in db.scalars(select(HouseholdMember).where(HouseholdMember.user_id.in_(ids))):
            m.joined_at = m.joined_at - timedelta(days=days_ago)
        db.commit()


def mail(to: str) -> list[str]:
    return [m.subject for m in outbox() if m.to == to]


def is_deleted(user_id: uuid.UUID) -> bool:
    with get_session_factory()() as db:
        user = db.get(User, user_id)
        return user is not None and user.deleted_at is not None


def test_the_partner_rides_the_owners_plan_after_their_own_trial_runs_out() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    household(asha, ben)
    # Covered from the moment he joins: no trial clock, no card ask.
    got = ben.get("/api/billing/entitlements").json()
    assert got["plan"] == "connected" and got["household"] is True
    assert got["access"] == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert access(asha)["shared"] == "holder" and access(asha)["state"] == "subscribed"

    now = datetime.now(UTC)
    set_user(ben_id, trial_ends_at=now - timedelta(days=1))  # day 4: his own trial is over
    assert access(ben)["state"] == "subscribed"
    # Day 10 and later: nothing closes him and nothing nags him.
    before = len(mail(ben_email))
    counts = run(now + timedelta(days=7), ben_id, asha_id)
    assert counts == {"ending_soon": 0, "ended": 0, "reminded": 0, "deleted": 0}
    assert not is_deleted(ben_id) and len(mail(ben_email)) == before
    # The shared jar keeps his deposits: his blob stays, and he can still write it.
    blob = {"ciphertext": "ZGF0YQ", "version": 1}
    assert ben.put("/api/household/blobs/jars", json=blob).status_code == 200
    # Nothing to buy or start while the shared plan covers him.
    assert ben.post("/api/billing/trial", json={"plan": "private"}).status_code == 409
    r = ben.post(
        "/api/billing/checkout",
        json={"plan": "connected", "interval": "monthly", "consent": PLACEHOLDER_CONSENT},
    )
    assert r.status_code in (409, 503), r.text
    if r.status_code == 409:
        assert r.json()["detail"] == "household_covered"
    billing = ben.get("/api/billing").json()
    assert billing["shared"] == "covered" and billing["shared_by"] == "Asha"
    assert asha.get("/api/billing").json()["shared"] == "holder"


def test_a_new_partner_joins_without_picking_a_trial() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, _, _ = person("Ben")
    assert access(ben)["state"] == "choose"
    household(asha, ben)
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}


def test_the_owners_trial_ends_for_both_with_the_same_notices_and_both_close_together() -> None:
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}

    now = datetime.now(UTC)
    set_user(asha_id, trial_ends_at=now + timedelta(hours=20))
    assert run(now, asha_id, ben_id)["ending_soon"] == 2
    assert run(now, asha_id, ben_id)["ending_soon"] == 0  # once each
    for to in (asha_email, ben_email):
        subject = mail(to)[-1]
        assert subject.startswith("Your shared free trial wraps up on"), subject
        text = next(m.text for m in reversed(outbox()) if m.to == to)
        assert "one price covers both of you" in text and "$" not in text

    set_user(asha_id, trial_ends_at=now - timedelta(minutes=1))
    a, b = access(asha), access(ben)
    assert a["state"] == b["state"] == "lapsed"
    assert a["delete_at"] == b["delete_at"]  # the same 7 days
    assert b["shared"] == "covered"
    assert run(now, asha_id, ben_id)["ended"] == 2
    assert mail(asha_email)[-1] == mail(ben_email)[-1] == "Your shared Qash trial has wrapped up"
    reminded = run(now + timedelta(days=3), asha_id, ben_id)
    assert reminded["reminded"] == 2

    # Day 7: one run closes both, whichever account it reaches first.
    closed = run(now + timedelta(days=7, hours=2), asha_id)
    assert closed["deleted"] == 2
    assert is_deleted(asha_id) and is_deleted(ben_id)
    assert mail(ben_email)[-1] == "Your Qash account has closed"
    closing = next(m.text for m in reversed(outbox()) if m.to == ben_email)
    assert "shared in your household" in closing


def test_a_cancelled_plan_ends_for_both_and_either_can_pick_it_up_again() -> None:
    asha, asha_id, asha_email = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    now = datetime.now(UTC)
    set_subscription(asha_id, cancel_at_period_end=True, renews_at=now + timedelta(hours=12))
    assert run(now, asha_id, ben_id)["ending_soon"] == 2
    assert mail(ben_email)[-1].startswith("Your shared Qash plan wraps up on")

    set_subscription(asha_id, status="canceled", ends_at=now - timedelta(hours=1))
    assert access(asha)["state"] == "lapsed" and access(ben)["state"] == "lapsed"
    # Ben subscribes in the 7 days: his plan becomes the household's, and covers Asha.
    grant_plan(str(ben_id), "connected")
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "holder"}
    assert access(asha) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert run(now + timedelta(days=8), asha_id, ben_id)["deleted"] == 0


def test_a_founding_term_reminds_both_once_per_stage() -> None:
    asha, asha_id, asha_email = person("Asha")
    grant_plan(str(asha_id), "founding")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    assert access(ben)["plan"] == "founding" and access(ben)["shared"] == "covered"
    now = datetime.now(UTC)
    set_subscription(asha_id, ends_at=now + timedelta(days=29))
    assert run(now, asha_id, ben_id)["ending_soon"] == 2
    assert run(now, asha_id, ben_id)["ending_soon"] == 0
    assert mail(ben_email)[-1].startswith("Your household's Founding membership ends on")
    assert run(now + timedelta(days=23), asha_id, ben_id)["ending_soon"] == 2  # the 7-day stage
    set_subscription(asha_id, ends_at=now - timedelta(minutes=1))
    assert run(now, asha_id, ben_id)["ended"] == 2
    assert (
        mail(asha_email)[-1]
        == mail(ben_email)[-1]
        == ("Your household's Founding membership has ended")
    )


def test_leaving_returns_the_partner_to_their_own_state_with_seven_days_and_an_email() -> None:
    """Owner decision, October 29, 2026: leaving never ends the holder's plan; the one
    the shared plan covered is on their own from then, with the 7 days and a note."""
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    assert ben.post("/api/household/leave").status_code == 204
    state = access(ben)
    assert state["state"] == "lapsed" and "shared" not in state
    left_at = datetime.fromisoformat(state["ended_at"])
    assert datetime.fromisoformat(state["delete_at"]) - left_at >= timedelta(days=7)
    assert access(asha) == {"state": "subscribed", "plan": "connected"}
    assert run(datetime.now(UTC), ben_id)["ended"] == 1
    assert mail(ben_email)[-1] == "Your household's plan no longer covers you"


def test_a_partner_with_a_plan_of_their_own_keeps_it_after_leaving() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    grant_plan(str(ben_id), "private")
    household(asha, ben)
    assert access(ben)["shared"] == "covered" and access(ben)["plan"] == "connected"
    assert ben.post("/api/household/leave").status_code == 204
    assert access(ben) == {"state": "subscribed", "plan": "private"}


def test_the_holder_closing_their_account_leaves_the_partner_seven_days() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    assert asha.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    state = access(ben)
    assert state["state"] == "lapsed" and "delete_at" in state


def test_the_partner_closing_their_account_never_ends_the_holders_plan() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, _, _ = person("Ben")
    household(asha, ben)
    assert ben.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert access(asha) == {"state": "subscribed", "plan": "connected"}


def test_a_disputed_payment_pauses_the_shared_plan_for_both_never_closing_either() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_subscription(asha_id, disputed_at=datetime.now(UTC))
    assert access(asha)["state"] == "paused"
    assert access(ben)["state"] == "paused" and access(ben)["shared"] == "covered"
    assert run(datetime.now(UTC) + timedelta(days=30), asha_id, ben_id)["deleted"] == 0
    with get_session_factory()() as db:
        stripe_billing._tell_covered_partner(db, asha_id, "disputed")
    assert mail(ben_email)[-1] == "Your household's Qash plan is paused"


def stored_plan(user_id: uuid.UUID) -> str | None:
    with get_session_factory()() as db:
        return db.scalar(
            select(Entitlement.value).where(
                Entitlement.user_id == user_id, Entitlement.key == "plan"
            )
        )


def test_the_stored_limits_follow_the_shared_plan_for_both() -> None:
    """The `entitlements` rows (the table the spec names) never go stale for the partner: they
    are written for both whenever either's plan changes, and on joining and leaving."""
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    assert stored_plan(ben_id) == "connected"
    set_subscription(asha_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(hours=1))
    with get_session_factory()() as db:
        store_entitlements(db, asha_id)  # what every billing path does after a change
        db.commit()
    assert stored_plan(ben_id) == "free"
    grant_plan(str(asha_id), "connected")
    assert stored_plan(ben_id) == "connected"
    assert ben.post("/api/household/leave").status_code == 204
    assert stored_plan(ben_id) == "free" and stored_plan(asha_id) == "connected"
