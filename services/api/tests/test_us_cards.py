"""Invariant 75: cards issued by a US bank only (owner decision, October 17, 2026).

Pricing only in dollars doesn't keep other cards out, and Radar Lite has no custom rules, so the
webhook checks the payer's country before any plan starts (October 30, 2026). A purchase paid
with a card from elsewhere never starts, whichever Stripe event comes first; its subscription
ends at once; anything it took comes back in full, once; the person is told once and the Plan
screen asks for a US card. A US card or bank account, or a country Stripe doesn't report,
starts the plan as before. A Stripe outage keeps nothing, so Stripe sends the event again.
"""

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import Subscription
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.test_billing import post_event
from tests.test_billing_oct29 import NOW, Stripe, _bought, _checkout, _event, _row, _state, member

CANADA = {"type": "card", "card": {"country": "CA", "brand": "visa"}}
US_CARD = {"type": "card", "card": {"country": "US", "brand": "visa"}}
US_BANK = {"type": "us_bank_account", "us_bank_account": {"bank_name": "STRIPE TEST BANK"}}
LINK = {"type": "link", "link": {}}


class Cards(Stripe):
    """The billing fake, plus payment methods: a subscription's default and a payment's own."""

    def __init__(self) -> None:
        super().__init__()
        self.methods: dict[str, dict] = {}
        self.intent_methods: dict[str, str] = {}
        self.down = False  # Stripe unreachable for payment methods

    def pays_with(self, sub_id: str, method: dict) -> None:
        pm = f"pm_{sub_id}"
        self.methods[pm] = {"id": pm, "object": "payment_method", **method}
        self.subs[sub_id]["default_payment_method"] = pm

    def transport(self) -> httpx2.MockTransport:
        inner = super().transport()

        def handle(request: httpx2.Request) -> httpx2.Response:
            path = request.url.path
            if path.startswith("/v1/payment_methods/"):
                self.calls.append((request.method, path, {}))
                if self.down:
                    return httpx2.Response(503, json={"error": "unavailable"})
                found = self.methods.get(path.rsplit("/", 1)[-1])
                return httpx2.Response(200, json=found) if found else httpx2.Response(404, json={})
            response = inner.handle_request(request)
            if path.startswith("/v1/payment_intents/") and response.status_code == 200:
                body = response.json()
                body["payment_method"] = self.intent_methods.get(body["id"])
                return httpx2.Response(200, json=body)
            return response

        return httpx2.MockTransport(handle)


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    yield
    stripe_billing.transport_override = None


@pytest.fixture
def stripe() -> Cards:
    fake = Cards()
    stripe_billing.transport_override = fake.transport()
    return fake


def _new(name: str, stripe: Cards, method: dict, *, amount: int = 300, plan: str = "private"):
    client, user_id = member(name)
    sub = f"sub_{name}"
    interval = "monthly" if plan == "private" else "yearly"
    stripe.subscription(sub, user_id, plan, interval)
    stripe.pays_with(sub, method)
    if amount:
        stripe.paid(sub, amount)
    outbox().clear()
    return client, user_id, sub


def _billing(client) -> dict:
    return client.get("/api/billing").json()


def test_a_plan_paid_with_a_card_from_outside_the_us_never_starts_and_comes_back_in_full(
    stripe: Cards,
) -> None:
    client, user_id, sub = _new("canada", stripe, CANADA)
    done = _checkout(sub, user_id, "private", "monthly")
    r = post_event(client, _event("checkout.session.completed", done))
    assert r.json()["outcome"] == "foreign_card", r.text
    assert stripe.deleted() == [sub]
    assert stripe.refunded() == [(f"pi_{sub}", 300, f"foreign_card:{sub}:pi_{sub}")]  # no fee
    row = _row(sub)
    assert (row.status, row.first_payment) == ("canceled", "foreign_card")
    assert _state(client)["plan"] != "private"
    assert _billing(client)["foreign_card_refused"] is True
    assert [m.subject for m in outbox()] == ["Your Qash plan didn't start"]
    assert "$" not in outbox()[0].text and "US bank" in outbox()[0].text
    # Delivered again, then Stripe's own events about the ended subscription: nothing more.
    post_event(client, _event("checkout.session.completed", done))
    late = post_event(
        client, _event("customer.subscription.updated", stripe.subs[sub] | {"status": "active"})
    )
    assert late.json()["outcome"] == "stale"
    assert len(stripe.refunds) == 1 and len(outbox()) == 1
    assert _state(client)["plan"] != "private"


def test_announced_by_the_subscription_first_it_never_starts_even_for_a_moment(
    stripe: Cards,
) -> None:
    client, user_id, sub = _new("canadafirst", stripe, CANADA)
    created = stripe.subs[sub] | {"default_payment_method": stripe.methods[f"pm_{sub}"]}
    r = post_event(client, _event("customer.subscription.created", created))
    assert r.json()["outcome"] == "foreign_card"
    assert _state(client)["plan"] != "private"
    r = post_event(
        client,
        _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly")),
    )
    assert r.json()["outcome"] == "foreign_card"
    assert len(stripe.refunds) == 1 and stripe.deleted().count(sub) == 1
    assert [m.subject for m in outbox()] == ["Your Qash plan didn't start"]


def test_a_trial_that_charged_nothing_yet_is_ended_with_nothing_to_refund(stripe: Cards) -> None:
    client, user_id, sub = _new("canadatrial", stripe, CANADA, amount=0)
    done = _checkout(sub, user_id, "private", "monthly", paid="no_payment_required")
    r = post_event(client, _event("checkout.session.completed", done))
    assert r.json()["outcome"] == "foreign_card"
    assert stripe.deleted() == [sub] and stripe.refunds == []
    assert [m.subject for m in outbox()] == ["Your Qash plan didn't start"]


@pytest.mark.parametrize(
    ("name", "method"), [("uscard", US_CARD), ("usbank", US_BANK), ("link", LINK)]
)
def test_a_us_card_a_us_bank_account_or_an_unknown_country_starts_the_plan(
    stripe: Cards, name: str, method: dict
) -> None:
    client, user_id, sub = _new(name, stripe, method)
    r = post_event(
        client,
        _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly")),
    )
    assert r.json()["outcome"] == "subscribed", r.text
    assert _state(client)["plan"] == "private"
    assert stripe.refunds == [] and stripe.deleted() == []
    assert _billing(client)["foreign_card_refused"] is False


def test_a_founding_payment_from_outside_the_us_takes_no_place_and_comes_back_in_full(
    stripe: Cards,
) -> None:
    client, user_id = member("foundingca")
    places = _billing(client)["founding"]
    stripe.charges.append(
        {
            "id": "ch_fca",
            "customer": "cus_fca",
            "payment_intent": "pi_fca",
            "amount": 15000,
            "amount_refunded": 0,
            "status": "succeeded",
            "created": NOW,
            "method": "card",
        }
    )
    stripe.methods["pm_fca"] = {"id": "pm_fca", **CANADA}
    stripe.intent_methods["pi_fca"] = "pm_fca"
    founding = {
        "id": "cs_fca",
        "mode": "payment",
        "payment_status": "paid",
        "client_reference_id": user_id,
        "customer": "cus_fca",
        "payment_intent": "pi_fca",
        "metadata": {"user_id": user_id, "plan": "founding"},
    }
    outbox().clear()
    r = post_event(client, _event("checkout.session.completed", founding))
    assert r.json()["outcome"] == "foreign_card"
    assert stripe.refunded() == [("pi_fca", 15000, "foreign_card:pi_fca")]
    assert _billing(client)["founding"] == places
    assert _state(client)["plan"] != "connected"
    post_event(client, _event("checkout.session.completed", founding))  # delivered again
    assert len(stripe.refunds) == 1 and len(outbox()) == 1


def test_stripe_unreachable_keeps_nothing_and_the_retry_refuses_it(stripe: Cards) -> None:
    client, user_id, sub = _new("canadadown", stripe, CANADA)
    event = _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly"))
    stripe.down = True
    assert post_event(client, event).status_code >= 500
    with get_session_factory()() as db:
        assert db.scalar(select(Subscription).where(Subscription.external_id == sub)) is None
    assert stripe.refunds == []
    # The person hears nothing until it's decided (the admins' error email is limited to one
    # an hour per kind, so whether it goes here depends on the tests before).
    assert [m for m in outbox() if not m.subject.startswith("Qash error:")] == []
    stripe.down = False
    assert post_event(client, event).json()["outcome"] == "foreign_card"  # Stripe's retry
    assert len(stripe.refunds) == 1


def test_buying_again_with_a_us_card_works_and_the_notice_goes(stripe: Cards) -> None:
    client, user_id, sub = _new("retry", stripe, CANADA)
    post_event(
        client, _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly"))
    )
    assert _billing(client)["foreign_card_refused"] is True
    again = f"{sub}_us"
    stripe.subscription(again, user_id, "private", "monthly")
    stripe.pays_with(again, US_CARD)
    stripe.paid(again, 300)
    r = post_event(
        client,
        _event("checkout.session.completed", _checkout(again, user_id, "private", "monthly")),
    )
    assert r.json()["outcome"] == "subscribed"
    assert _state(client)["plan"] == "private"
    assert _billing(client)["foreign_card_refused"] is False


def test_a_second_plan_on_a_foreign_card_is_refunded_once_as_a_second_plan(stripe: Cards) -> None:
    client, user_id, _ = _bought("secondca", stripe)
    stripe.subscription("sub_b_secondca", user_id, "connected", "yearly")
    stripe.pays_with("sub_b_secondca", CANADA)
    stripe.paid("sub_b_secondca", 6500)
    outbox().clear()
    done = _checkout("sub_b_secondca", user_id, "connected", "yearly")
    assert post_event(client, _event("checkout.session.completed", done)).json()["outcome"] == (
        "second_plan"
    )
    post_event(client, _event("checkout.session.completed", done))
    assert stripe.refunded() == [
        ("pi_sub_b_secondca", 6500, "second_plan:sub_b_secondca:pi_sub_b_secondca")
    ]
    assert [m.subject for m in outbox()] == ["We refunded a second Qash plan"]
    assert _state(client)["plan"] == "private"


def test_every_request_names_the_pinned_api_version() -> None:
    seen: list[str | None] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.headers.get("stripe-version"))
        method = {"type": "card", "card": {"country": "US"}}
        return httpx2.Response(200, json={"id": "pi_x", "payment_method": method})

    stripe_billing.transport_override = httpx2.MockTransport(handle)
    assert stripe_billing.payer_country(payment_intent="pi_x") == "US"
    assert seen and set(seen) == {"2026-09-30.endive"}


@pytest.mark.parametrize("why", ["foreign_card", "second_plan"])
def test_a_subscription_first_announced_incomplete_is_checked_when_it_turns_active(
    stripe: Cards, why: str
) -> None:
    """Review of #62: Stripe may announce a subscription `incomplete` (a payment being
    confirmed), then `active`. The checks run on that start too, or the plan would be granted
    until the checkout event arrives (invariants 41 and 75)."""
    if why == "second_plan":
        client, user_id, _ = _bought("incsecond", stripe)
        sub = "sub_b_incsecond"
        stripe.subscription(sub, user_id, "connected", "yearly")
        stripe.pays_with(sub, US_CARD)
        stripe.paid(sub, 6500)
        before = "private"
    else:
        client, user_id, sub = _new("incforeign", stripe, CANADA)
        before = _state(client)["plan"]
    method = stripe.methods[f"pm_{sub}"]
    started = stripe.subs[sub] | {"default_payment_method": method}
    created = post_event(
        client, _event("customer.subscription.created", started | {"status": "incomplete"})
    )
    assert created.status_code == 200, created.text
    r = post_event(client, _event("customer.subscription.updated", started | {"status": "active"}))
    assert r.json()["outcome"] == why, r.text
    assert _state(client)["plan"] == before
    assert stripe.deleted().count(sub) == 1 and len(stripe.refunds) == 1
