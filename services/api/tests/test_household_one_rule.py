"""A household's plan is decided by one rule (October 29, 2026; invariants 54, 67-70).

The owner's test of PR #53 found four gaps, each because a path decided the household's plan
on its own instead of asking `entitlements.household_plan`:

1. The household's owner, covered by the partner's plan, was given their own old state back
   when that plan ended or was disputed: closed by the next hourly run with no ended email and
   no 7 days, and never shown "paused" during a dispute.
4. The limits applied (`effective_plan`) used the person's own subscription before the
   household's cover, so a covered person who also paid for Private got Private's limits, and
   an owner paying Private beside a partner paying Connected was refused shared jar writes.
5. Switching down to a plan without household dropped the partner silently: no notice, no 7
   days, and a fresh trial on offer.
6. A household could pay twice: a page opened before joining, paid after it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import CheckoutPage
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import buy, post_event
from tests.test_billing_change import FakeStripe as ChangeStripe
from tests.test_billing_change import change, started_days_ago
from tests.test_billing_oct29 import Stripe, _checkout, _event, _row
from tests.test_household_one_plan import (
    access,
    household,
    is_deleted,
    mail,
    person,
    run,
    set_subscription,
    set_user,
)

BLOB = {"ciphertext": "ZGF0YQ", "version": 1}


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


def _partner_holds(now: datetime):
    """Asha (the owner) started the household on a trial that ended 20 days ago; Ben, her
    partner, subscribed to Connected within its 7 days, so his plan covers them both."""
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_user(asha_id, trial_ends_at=now - timedelta(days=20))
    grant_plan(str(ben_id), "connected")
    assert access(asha) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    return asha, asha_id, asha_email, ben, ben_id, ben_email


# --- 1. The owner covered by the partner -------------------------------------------------------


def test_the_owner_covered_by_the_partners_plan_gets_its_end_the_email_and_seven_days() -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email, ben, ben_id, ben_email = _partner_holds(now)
    ended = now - timedelta(hours=1)
    set_subscription(ben_id, status="canceled", ends_at=ended)
    a, b = access(asha), access(ben)
    assert a["state"] == b["state"] == "lapsed"
    assert a["delete_at"] == b["delete_at"]  # the same 7 days, from Ben's plan's end
    assert datetime.fromisoformat(a["ended_at"]) == ended
    assert run(now, asha_id, ben_id) == {"ending_soon": 0, "ended": 2, "reminded": 0, "deleted": 0}
    assert not is_deleted(asha_id)
    assert mail(asha_email)[-1] == mail(ben_email)[-1] == "Your shared Qash plan has wrapped up"
    assert run(now + timedelta(days=7, hours=2), asha_id)["deleted"] == 2


def test_the_owner_covered_by_the_partners_disputed_plan_is_paused_and_never_closed() -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email, ben, ben_id, _ = _partner_holds(now)
    set_subscription(ben_id, disputed_at=now)
    assert access(ben)["state"] == "paused"
    assert access(asha)["state"] == "paused" and access(asha)["shared"] == "covered"
    assert run(now + timedelta(days=30), asha_id, ben_id)["deleted"] == 0
    assert not is_deleted(asha_id)
    with get_session_factory()() as db:
        stripe_billing._tell_covered_partner(db, ben_id, "disputed")
    assert mail(asha_email)[-1] == "Your household's Qash plan is paused"


# --- 4. One plan applies, the one shown --------------------------------------------------------


def test_a_covered_person_paying_private_gets_the_households_limits() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "private")
    got = ben.get("/api/billing/entitlements").json()
    assert got["access"]["shared"] == "covered" and got["access"]["plan"] == "connected"
    assert got["plan"] == "connected" and got["bank_links_max"] == 3 and got["household"] is True


def test_an_owner_paying_private_beside_a_partner_paying_connected_shares_jars() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "connected")
    set_subscription(asha_id, plan="private")  # Asha switched down; Ben's plan holds
    got = asha.get("/api/billing/entitlements").json()
    assert got["access"] == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert got["plan"] == "connected"
    assert asha.put("/api/household/blobs/jars", json=BLOB).status_code == 200
    assert ben.put("/api/household/blobs/jars", json=BLOB).status_code == 200


# --- 5. Switching down ends the cover, with notice ---------------------------------------------


def test_switching_down_gives_the_partner_the_email_and_seven_days_and_no_new_trial() -> None:
    asha, asha_id, asha_email = person("Asha")
    grant_plan(str(asha_id), "connected", interval="yearly")
    started_days_ago(str(asha_id), 40)
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    fake = ChangeStripe("price_connected_y")
    fake.due, fake.total = 0, -7199
    stripe_billing.transport_override = fake.transport()
    preview = asha.post(
        "/api/billing/change/preview", json={"plan": "private", "interval": "yearly"}
    ).json()
    # The holder is told first, in the sheet, what it means for Ben.
    assert any("Ben" in p and "7 days" in p for p in preview["consent"]["lines"]), preview
    r = change(asha, "private", "yearly", proration_date=preview["proration_date"])
    assert r.status_code == 200, r.text
    state = access(ben)
    assert state["state"] == "lapsed", state
    started = datetime.fromisoformat(state["ended_at"])
    assert abs((datetime.now(UTC) - started).total_seconds()) < 60
    assert datetime.fromisoformat(state["delete_at"]) - started >= timedelta(days=7)
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 409
    assert access(asha) == {"state": "subscribed", "plan": "private"}
    assert run(datetime.now(UTC), asha_id, ben_id)["ended"] == 1
    assert mail(ben_email)[-1] == "Your household's plan no longer covers you"
    assert run(datetime.now(UTC), asha_id, ben_id)["ended"] == 0  # once
    assert not any("wrapped up" in s for s in mail(asha_email))


# --- 6. Never paid twice -----------------------------------------------------------------------


def test_joining_a_household_closes_the_joiners_open_payment_pages() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    r = ben.post("/api/billing/checkout", json=buy(ben, plan="connected", interval="yearly"))
    assert r.status_code == 200, r.text
    stripe.expire_status = 200  # still open at Stripe
    household(asha, ben)
    expired = [p for m, p, _ in stripe.calls if p.endswith("/expire")]
    assert expired == ["/v1/checkout/sessions/cs_1/expire"]
    with get_session_factory()() as db:
        pages = db.scalars(select(CheckoutPage).where(CheckoutPage.user_id == ben_id)).all()
        assert pages and all(p.expires_at <= datetime.now(UTC) for p in pages)


def test_a_page_paid_after_joining_a_household_is_ended_and_refunded_once() -> None:
    """The page was already being paid as he joined: the household's plan covers him, so this
    second plan is ended at Stripe and refunded in full, once, with the plain email."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    stripe.subscription("sub_b_twice", str(ben_id), "connected", "yearly")
    stripe.paid("sub_b_twice", 6500)
    outbox().clear()
    done = _checkout("sub_b_twice", str(ben_id), "connected", "yearly")
    outcome = post_event(ben, _event("checkout.session.completed", done)).json()["outcome"]
    assert outcome == "second_plan"
    assert stripe.deleted() == ["sub_b_twice"]
    assert len(stripe.refunds) == 1
    assert _row("sub_b_twice").first_payment == "refused"
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert mail(ben_email) == ["We refunded a second Qash plan"]
    post_event(ben, _event("checkout.session.completed", done))
    assert len(stripe.refunds) == 1 and len(mail(ben_email)) == 1
