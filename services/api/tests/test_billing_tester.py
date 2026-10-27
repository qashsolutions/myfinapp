"""Tester tools (owner decision, October 18, 2026): an admin named in STACKD_ADMIN_EMAILS switches
their own plan for free to test every plan and skips the 30-day downgrade wait. For anyone else
the route does not exist (404) and a stored tester plan is ignored."""

import uuid

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import get_session_factory
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import member
from tests.test_billing_change import FakeStripe, change, started_days_ago


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    saved = get_settings().admin_emails
    yield
    get_settings().admin_emails = saved
    stripe_billing.transport_override = None


def admin(name: str):
    client, user_id = member(name)
    email = client.get("/api/auth/session").json()["user"]["email"]
    get_settings().admin_emails = [email.upper()]  # matched without regard to case
    return client, user_id


def test_the_route_does_not_exist_for_anyone_else() -> None:
    client, _ = member("plain")
    assert client.get("/api/billing").json()["tester"] is False
    r = client.post("/api/billing/tester", json={"plan": "connected"})
    assert (r.status_code, r.json()["detail"]) == (404, "not_found")
    assert client.get("/api/billing/entitlements").json()["plan"] == "free"


def test_an_admin_switches_to_every_plan_for_free_and_back() -> None:
    client, user_id = admin("owner")
    grant_plan(user_id, "private", interval="yearly")  # the real plan
    assert client.get("/api/billing").json()["tester"] is True
    for plan, links in (("connected", 3), ("founding", 3), ("free", 0), ("private", 0)):
        mails = len(outbox())
        r = client.post("/api/billing/tester", json={"plan": plan})
        assert r.status_code == 200, r.text
        assert (r.json()["plan"], r.json()["tester_plan"]) == (plan, plan)
        ent = client.get("/api/billing/entitlements").json()
        assert ent["plan"] == plan and ent["bank_links_max"] == links
        assert ent["access"]["state"] == "subscribed"  # never locked while testing
        assert len(outbox()) == mails + 1  # the always-on "your plan changed" alert
    r = client.post("/api/billing/tester", json={"plan": None})
    assert (r.json()["plan"], r.json()["tester_plan"]) == ("private", None)
    with get_session_factory()() as db:
        targets = db.scalars(
            select(AuditLog.target).where(AuditLog.actor_id == uuid.UUID(user_id))
        ).all()
    assert "tester:connected" in targets and "tester:real" in targets
    # Nothing went near Stripe.
    assert client.get("/api/billing/credit").json()["refund_if_deleted_cents"] == 0


def test_a_tester_plan_is_ignored_once_the_email_is_not_an_admin() -> None:
    client, user_id = admin("former")
    assert client.post("/api/billing/tester", json={"plan": "connected"}).status_code == 200
    get_settings().admin_emails = []
    assert client.get("/api/billing/entitlements").json()["plan"] == "free"
    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None and user.tester_plan == "connected"  # kept, but inert


def test_an_admin_may_switch_down_at_once_and_billing_uses_the_real_plan() -> None:
    client, user_id = admin("quick")
    grant_plan(user_id, "connected", interval="yearly")
    started_days_ago(user_id, 2)
    stripe = FakeStripe("price_connected_y")
    stripe_billing.transport_override = stripe.transport()
    assert client.get("/api/billing").json()["downgrade_from"] is None
    # A tester plan on top never lets a second subscription start.
    assert client.post("/api/billing/tester", json={"plan": "free"}).status_code == 200
    r = client.post("/api/billing/change/preview", json={"plan": "private", "interval": "yearly"})
    assert r.status_code == 200 and r.json()["kind"] == "down"
    assert change(client, "private", "yearly").status_code == 200
