"""Checkout, the portal, webhooks (signed, applied once) and the limits they unlock."""

import json
import time
import uuid

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import PurchaseConsent
from app.services import stripe_billing
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.webauthn_fake import FakeAuthenticator

SECRET = "whsec_test_stackd"


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


class FakeStripe:
    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            self.requests.append(request)
            if request.url.path == "/v1/checkout/sessions":
                return httpx2.Response(
                    200,
                    json={"id": "cs_test_1", "url": "https://checkout.stripe.com/c/pay/cs_test_1"},
                )
            if request.url.path == "/v1/billing_portal/sessions":
                return httpx2.Response(
                    200, json={"id": "bps_1", "url": "https://billing.stripe.com/p/session/1"}
                )
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def member(name: str):
    client = new_client()
    sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    return client, client.get("/api/auth/session").json()["user"]["id"]


def post_event(client, event: dict, *, timestamp: int | None = None):
    payload = json.dumps(event).encode()
    header = stripe_billing.sign(payload, SECRET, timestamp=timestamp or int(time.time()))
    return client.post(
        "/api/webhooks/stripe",
        content=payload,
        headers={"stripe-signature": header, "content-type": "application/json"},
    )


CONSENT = {
    "version": "2026-10-24",
    "lines": ["$20.00 today, then every year.", "Renews automatically each year until you cancel."],
    "agreement": "I understand my plan renews every year until I cancel.",
    "accepted": True,
}


def buy(**body):
    return {**body, "consent": CONSENT}


def test_free_plan_and_prices() -> None:
    client, _ = member("maya")
    r = client.get("/api/billing")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["plan"] == "free" and data["label"] == "No plan" and data["available"] is True
    assert data["prices"]["private"] == {"monthly_cents": 300, "yearly_cents": 2000}
    assert data["prices"]["connected"] == {"monthly_cents": 700, "yearly_cents": 6500}
    assert data["founding"]["one_time_cents"] == 15000 and data["founding"]["term_years"] == 4
    assert (
        data["entitlements"]["goals_active_max"] == 2
        and data["entitlements"]["groups_create"] is False
    )
    assert client.get("/api/billing/entitlements").json()["plan"] == "free"


def test_checkout_sends_the_price_and_the_user_to_stripe() -> None:
    client, user_id = member("maya")
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    assert client.post("/api/billing/checkout", json=buy(plan="private")).status_code == 422
    # No consent, a stale consent version, or an unticked box: no payment page.
    no_consent = {"plan": "private", "interval": "yearly"}
    assert client.post("/api/billing/checkout", json=no_consent).status_code == 422
    stale = {**no_consent, "consent": {**CONSENT, "version": "2020-01-01"}}
    assert client.post("/api/billing/checkout", json=stale).status_code == 409
    unticked = {**no_consent, "consent": {**CONSENT, "accepted": False}}
    assert client.post("/api/billing/checkout", json=unticked).status_code == 422
    assert stripe.requests == []
    r = client.post("/api/billing/checkout", json=buy(plan="private", interval="yearly"))
    assert r.status_code == 200, r.text
    assert r.json()["url"].startswith("https://checkout.stripe.com/")
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    assert form["mode"] == "subscription"
    # Cards only, through the cards-only payment method configuration: Stripe refuses the old
    # payment_method_types on Checkout (October 24, 2026).
    assert form["payment_method_configuration"] == "pmc_cards_only"
    assert not any(k.startswith("payment_method_types") for k in form)
    assert "US+bank" in form["custom_text%5Bsubmit%5D%5Bmessage%5D"]
    assert form["line_items%5B0%5D%5Bprice%5D"] == "price_private_y"
    assert form["client_reference_id"] == user_id
    assert form["success_url"].endswith("%2Fme%2Fplan%3Fcheckout%3Dsuccess")
    assert stripe.requests[-1].url.host == "api.stripe.com"
    assert stripe.requests[-1].headers["authorization"] == "Bearer sk_test_stackd"
    r = client.post("/api/billing/checkout", json=buy(plan="founding"))
    assert r.status_code == 200
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    assert form["mode"] == "payment" and form["line_items%5B0%5D%5Bprice%5D"] == "price_founding"
    assert client.post("/api/billing/portal").status_code == 404  # no customer yet
    # Each agreement is kept: what was shown, the price, when; no card data.
    with get_session_factory()() as db:
        rows = db.scalars(
            select(PurchaseConsent)
            .where(PurchaseConsent.user_id == uuid.UUID(user_id))
            .order_by(PurchaseConsent.agreed_at)
        ).all()
    assert [(r.plan, r.interval, r.price_cents) for r in rows] == [
        ("private", "yearly", 2000),
        ("founding", None, 15000),
    ]
    assert rows[0].terms_version == "2026-10-24"
    assert rows[0].terms_text.endswith("[x] I understand my plan renews every year until I cancel.")
    assert rows[0].email_hash and "@" not in rows[0].email_hash


def test_webhooks_are_verified_and_applied_once() -> None:
    client, user_id = member("maya")
    event = {
        "id": "evt_1",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_1",
                "mode": "subscription",
                "payment_status": "paid",
                "client_reference_id": user_id,
                "customer": "cus_1",
                "subscription": "sub_1",
                "metadata": {"user_id": user_id, "plan": "private", "interval": "yearly"},
            }
        },
    }
    payload = json.dumps(event).encode()
    assert (
        client.post(
            "/api/webhooks/stripe", content=payload, headers={"stripe-signature": "t=1,v1=bad"}
        ).status_code
        == 400
    )
    assert post_event(client, event, timestamp=int(time.time()) - 3600).status_code == 400  # stale
    r = post_event(client, event)
    assert r.status_code == 200 and r.json()["outcome"] == "subscribed"
    assert post_event(client, event).json()["outcome"] == "duplicate"
    data = client.get("/api/billing").json()
    assert data["plan"] == "private" and data["status"] == "active" and data["interval"] == "yearly"
    assert data["entitlements"]["goals_active_max"] == 4 and data["has_customer"] is True

    renews = int(time.time()) + 30 * 86400
    r = post_event(
        client,
        {
            "id": "evt_2",
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_1",
                    "status": "active",
                    "customer": "cus_1",
                    "cancel_at_period_end": True,
                    "metadata": {"user_id": user_id, "plan": "private", "interval": "yearly"},
                    "items": {
                        "data": [{"price": {"id": "price_private_y"}, "current_period_end": renews}]
                    },
                }
            },
        },
    )
    assert r.json()["outcome"] == "active"
    data = client.get("/api/billing").json()
    assert data["cancel_at_period_end"] is True and data["renews_at"] is not None

    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    r = client.post("/api/billing/portal")
    assert r.status_code == 200 and r.json()["url"].startswith("https://billing.stripe.com/")
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    assert form["customer"] == "cus_1"

    r = post_event(
        client,
        {
            "id": "evt_3",
            "type": "customer.subscription.deleted",
            "data": {
                "object": {
                    "id": "sub_1",
                    "status": "canceled",
                    "customer": "cus_1",
                    "metadata": {"user_id": user_id},
                }
            },
        },
    )
    assert r.json()["outcome"] == "canceled"
    assert client.get("/api/billing").json()["plan"] == "free"


def test_founding_member_is_four_years_of_connected_without_renewal() -> None:
    client, user_id = member("maya")
    r = post_event(
        client,
        {
            "id": "evt_f",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_f",
                    "mode": "payment",
                    "payment_status": "paid",
                    "client_reference_id": user_id,
                    "customer": "cus_f",
                    "payment_intent": "pi_f",
                    "metadata": {"plan": "founding"},
                }
            },
        },
    )
    assert r.json()["outcome"] == "founding"
    data = client.get("/api/billing").json()
    assert data["plan"] == "founding" and data["label"] == "Founding member"
    assert data["renews_at"] is None and data["ends_at"] is not None and data["interval"] is None
    assert (
        data["entitlements"]["goals_active_max"] == 10 and data["entitlements"]["household"] is True
    )
    assert (
        client.post(
            "/api/billing/checkout", json=buy(plan="private", interval="monthly")
        ).status_code
        == 409
    )


def test_plan_limits_on_groups() -> None:
    free, free_id = member("free")
    private, private_id = member("private")
    grant_plan(private_id, "private")
    assert free.post("/api/groups", json={"name": "Nope", "month": "2026-10"}).status_code == 403
    assert (
        free.post("/api/groups", json={"name": "Nope", "month": "2026-10"}).json()["detail"]
        == "plan_required"
    )
    g1 = private.post("/api/groups", json={"name": "One", "month": "2026-10"})
    assert g1.status_code == 201, g1.text
    g2 = private.post("/api/groups", json={"name": "Two", "month": "2026-10"}).json()
    assert free.post("/api/groups/join", json={"code": g1.json()["invite_code"]}).status_code == 200
    r = free.post("/api/groups/join", json={"code": g2["invite_code"]})
    assert r.status_code == 403 and r.json()["detail"] == "plan_limit"
    assert (
        free.post("/api/groups/join", json={"code": g1.json()["invite_code"]}).status_code == 200
    )  # already in: no-op
    grant_plan(free_id, "connected")
    assert free.post("/api/groups/join", json={"code": g2["invite_code"]}).status_code == 200


def _subscribe(client, user_id: str, sub_id: str) -> None:
    event = {
        "id": f"evt_{sub_id}",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": f"cs_{sub_id}",
                "mode": "subscription",
                "payment_status": "paid",
                "client_reference_id": user_id,
                "customer": f"cus_{sub_id}",
                "subscription": sub_id,
                "metadata": {"user_id": user_id, "plan": "private", "interval": "yearly"},
            }
        },
    }
    assert post_event(client, event).json()["outcome"] == "subscribed"


class CancelStripe:
    """Stripe's DELETE /v1/subscriptions/{id}; `down` makes it unreachable."""

    def __init__(self) -> None:
        self.cancelled: list[str] = []
        self.down = False

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            if self.down:
                return httpx2.Response(503, json={"error": "down"})
            if request.method == "DELETE" and request.url.path.startswith("/v1/subscriptions/"):
                self.cancelled.append(request.url.path.rsplit("/", 1)[-1])
                return httpx2.Response(200, json={"status": "canceled"})
            if request.method == "GET" and request.url.path.startswith("/v1/customers/"):
                return httpx2.Response(200, json={"balance": 0})  # no credit to refund
            if request.method == "GET" and request.url.path.startswith("/v1/subscriptions/"):
                return httpx2.Response(200, json={"id": "sub", "items": {"data": [{"id": "si"}]}})
            if request.method == "GET" and request.url.path in ("/v1/charges", "/v1/refunds"):
                return httpx2.Response(200, json={"data": []})  # nothing charged since
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def test_deleting_an_account_ends_its_stripe_subscription_at_once() -> None:
    from datetime import UTC, datetime

    from app.models.billing import Subscription
    from app.models.user import User
    from app.services.deletion import soft_delete

    client, user_id = member("leaving")
    _subscribe(client, user_id, "sub_leave")
    stripe = CancelStripe()
    stripe_billing.transport_override = stripe.transport()
    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        soft_delete(db, user)
        db.commit()
        sub = db.scalars(select(Subscription).where(Subscription.external_id == "sub_leave")).one()
        assert sub.status == "canceled" and sub.ends_at is not None
        assert sub.ends_at <= datetime.now(UTC)
    assert "sub_leave" in stripe.cancelled


def test_the_purge_waits_while_stripe_cannot_be_reached() -> None:
    from datetime import UTC, datetime, timedelta

    from app.models.user import User
    from app.services.deletion import purge_due, soft_delete

    client, user_id = member("stuck")
    _subscribe(client, user_id, "sub_stuck")
    stripe = CancelStripe()
    stripe.down = True
    stripe_billing.transport_override = stripe.transport()
    later = datetime.now(UTC) + timedelta(days=31)
    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        soft_delete(db, user)
        db.commit()
        assert purge_due(db, grace_days=30, now=later) >= 0
        db.commit()
        assert db.get(User, uuid.UUID(user_id)) is not None  # kept: Stripe may still charge
        stripe.down = False
        purge_due(db, grace_days=30, now=later)
        db.commit()
        assert db.get(User, uuid.UUID(user_id)) is None
    assert "sub_stuck" in stripe.cancelled


def test_the_purge_takes_the_person_before_their_plans_so_a_webhook_waits() -> None:
    """A webhook locks the person, then their plans (`_lock_person`); the purge must take them in
    the same order, or each waits on the other and Postgres aborts one (October 25, 2026)."""
    import threading
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import text

    from app.models.user import User
    from app.services.deletion import purge_due, soft_delete

    client, user_id = member("race")
    _subscribe(client, user_id, "sub_race")
    stripe = CancelStripe()
    stripe.down = True  # the deletion couldn't end the plan, so the purge will
    stripe_billing.transport_override = stripe.transport()
    later = datetime.now(UTC) + timedelta(days=31)
    factory = get_session_factory()
    with factory() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        soft_delete(db, user)
        db.commit()
    stripe.down = False

    errors: list[BaseException] = []
    purged: list[int] = []
    with factory() as webhook:
        # The webhook's first step: the person's row, as _lock_person takes it
        webhook.execute(text("SET LOCAL lock_timeout = '5s'"))
        webhook.execute(
            text("SELECT id FROM users WHERE id = :id FOR NO KEY UPDATE"), {"id": user_id}
        )

        def purge() -> None:
            try:
                with factory() as db, db.begin():
                    db.execute(text("SET LOCAL lock_timeout = '10s'"))
                    purged.append(purge_due(db, grace_days=30, now=later))
            except BaseException as e:  # noqa: BLE001 - reported below
                errors.append(e)

        worker = threading.Thread(target=purge)
        worker.start()
        time.sleep(1.0)  # the purge is now as far as it can get while the webhook holds the person
        # The webhook's second step: its plans. The purge must not be holding them.
        try:
            webhook.execute(
                text("UPDATE subscriptions SET updated_at = now() WHERE user_id = :id"),
                {"id": user_id},
            )
            webhook.commit()
        except BaseException as e:  # noqa: BLE001
            errors.append(e)
            webhook.rollback()
        worker.join(timeout=30)
    assert not worker.is_alive()
    assert errors == []
    assert purged == [1]
    with factory() as db:
        assert db.get(User, uuid.UUID(user_id)) is None
    assert "sub_race" in stripe.cancelled


def test_one_account_failing_in_the_purge_never_stops_the_rest(monkeypatch) -> None:
    from datetime import UTC, datetime, timedelta

    from sqlalchemy.exc import OperationalError

    import app.routers.linking as linking
    from app.models.user import User
    from app.services.deletion import purge_due, soft_delete

    ids = [member(name)[1] for name in ("first", "second")]
    stuck = uuid.UUID(ids[0])
    real = linking.revoke_all
    purging = False

    def revoke_all(db, user_id):
        if purging and user_id == stuck:
            raise OperationalError("SELECT 1", {}, Exception("lock timeout"))
        return real(db, user_id)

    monkeypatch.setattr(linking, "revoke_all", revoke_all)
    later = datetime.now(UTC) + timedelta(days=31)
    factory = get_session_factory()
    with factory() as db:
        for i in ids:
            soft_delete(db, db.get(User, uuid.UUID(i)))
        db.commit()
    purging = True
    with factory() as db, db.begin():
        assert purge_due(db, grace_days=30, now=later) >= 1
    with factory() as db:
        assert db.get(User, stuck) is not None  # kept for the next run
        assert db.get(User, uuid.UUID(ids[1])) is None
    purging = False  # the next run takes it, and no account is left for later tests
    with factory() as db, db.begin():
        purge_due(db, grace_days=30, now=later)
    with factory() as db:
        assert db.get(User, stuck) is None
