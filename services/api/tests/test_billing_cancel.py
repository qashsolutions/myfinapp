"""Cancel and resume (owner decision, October 13, 2026): cancelling stops renewal and the plan
keeps working until the end of the period already paid for; then the account is Free."""

import time
import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx2
import pytest
from sqlalchemy import select, text

from app.db import get_session_factory
from app.models.billing import PurchaseConsent, Subscription
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import CONSENT, member, post_event

PERIOD_END = int(time.time()) + 20 * 86400  # 20 days of the paid month left


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


class FakeStripe:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, list[str]]]] = []

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            form = parse_qs(request.content.decode())
            self.calls.append((request.url.path, form))
            if request.url.path.startswith("/v1/subscriptions/"):
                return httpx2.Response(
                    200,
                    json={
                        "id": request.url.path.rsplit("/", 1)[-1],
                        "status": "active",
                        "cancel_at_period_end": form["cancel_at_period_end"] == ["true"],
                        "current_period_end": PERIOD_END,
                    },
                )
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


# The "If you cancel" sheet's ticked box (owner decision, October 18, 2026).
CANCEL = {
    "consent": {
        **CONSENT,
        "lines": ["Keep everything: Connected stays on until Oct 26, 2026."],
        "agreement": "I have read and understood these terms.",
    }
}


def sub_row(user_id: str) -> Subscription:
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None
        db.expunge(row)
        return row


def test_cancel_keeps_the_plan_until_the_paid_period_ends_and_resume_undoes_it() -> None:
    client, user_id = member("cancel")
    grant_plan(user_id, "connected", interval="monthly")
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()

    # No tick, no cancellation (owner decision, October 18, 2026).
    assert client.post("/api/billing/cancel").status_code == 422
    assert client.post("/api/billing/cancel", json={}).status_code == 422
    assert stripe.calls == []

    r = client.post("/api/billing/cancel", json=CANCEL)
    assert r.status_code == 200, r.text
    with get_session_factory()() as db:
        kept = db.scalars(
            select(PurchaseConsent).where(PurchaseConsent.user_id == uuid.UUID(user_id))
        ).all()
    assert [(c.kind, c.plan, c.interval) for c in kept] == [("cancel", "connected", "monthly")]
    assert kept[0].terms_text.endswith("[x] I have read and understood these terms.")
    body = r.json()
    assert body["plan"] == "connected"  # still on: the month is paid for
    assert body["cancel_at_period_end"] is True
    assert body["renews_at"].startswith(
        datetime.fromtimestamp(PERIOD_END, tz=UTC).date().isoformat()
    )
    path, form = stripe.calls[-1]
    assert path == f"/v1/subscriptions/{sub_row(user_id).external_id}"
    assert form == {"cancel_at_period_end": ["true"]}
    assert client.get("/api/billing/entitlements").json()["plan"] == "connected"
    assert any("plan" in m.subject.lower() for m in outbox())  # the always-on alert

    # Cancelling twice changes nothing and asks Stripe nothing.
    n = len(stripe.calls)
    assert client.post("/api/billing/cancel", json=CANCEL).json()["cancel_at_period_end"] is True
    assert len(stripe.calls) == n

    r = client.post("/api/billing/resume")
    assert r.status_code == 200 and r.json()["cancel_at_period_end"] is False
    assert stripe.calls[-1][1] == {"cancel_at_period_end": ["false"]}


def test_when_the_period_ends_the_account_is_free_and_nothing_is_deleted() -> None:
    client, user_id = member("ended")
    grant_plan(user_id, "connected", interval="monthly")
    external = sub_row(user_id).external_id
    ended = int(time.time()) - 60
    r = post_event(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "customer.subscription.deleted",
            "data": {
                "object": {
                    "id": external,
                    "status": "canceled",
                    "current_period_end": ended,
                    "metadata": {"user_id": user_id, "plan": "connected", "interval": "monthly"},
                }
            },
        },
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/billing").json()["plan"] == "free"


def test_a_cancelled_plan_still_counts_until_its_end_date() -> None:
    client, user_id = member("grace")
    grant_plan(user_id, "private", interval="yearly")
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE subscriptions SET status = 'canceled', renews_at = NULL, "
                "ends_at = now() + interval '200 days' WHERE user_id = :u"
            ),
            {"u": user_id},
        )
    assert client.get("/api/billing").json()["plan"] == "private"
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE subscriptions SET ends_at = now() - interval '1 minute' WHERE user_id = :u"
            ),
            {"u": user_id},
        )
    assert client.get("/api/billing").json()["plan"] == "free"


def test_founding_never_renews_so_there_is_nothing_to_cancel() -> None:
    client, user_id = member("founder")
    grant_plan(user_id, "founding")
    r = client.post("/api/billing/cancel", json=CANCEL)
    assert r.status_code == 409 and r.json()["detail"] == "does_not_renew"
    assert client.get("/api/billing").json()["plan"] == "founding"


def test_store_plans_are_cancelled_in_the_store_and_free_has_nothing() -> None:
    client, user_id = member("store")
    grant_plan(user_id, "private", interval="monthly")
    with get_session_factory()() as db, db.begin():
        db.execute(
            text("UPDATE subscriptions SET source = 'apple' WHERE user_id = :u"), {"u": user_id}
        )
    r = client.post("/api/billing/cancel", json=CANCEL)
    assert r.status_code == 409 and r.json()["detail"] == "manage_in_store"
    other, _ = member("freeuser")
    assert other.post("/api/billing/cancel", json=CANCEL).json()["detail"] == "no_subscription"


def test_cancelling_needs_a_fresh_passkey() -> None:
    client, user_id = member("stale")
    grant_plan(user_id, "connected", interval="monthly")
    session_id = client.get("/api/auth/session").json()["session_id"]
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": session_id},
        )
    assert client.post("/api/billing/cancel", json=CANCEL).status_code == 403
