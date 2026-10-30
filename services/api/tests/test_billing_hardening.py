"""Billing hardening (October 24, 2026): webhook ordering, paid-only checkouts, refunds that a
retry can never pay twice, and the Founding cap checked again when the payment lands."""

import copy
import time
import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import Subscription
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import CONSENT, FakeStripe, buy, member, post_event


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


T0 = int(time.time()) - 3600


def _event(kind: str, obj: dict, created: int) -> dict:
    return {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": kind,
        "created": created,
        "data": {"object": obj},
    }


def _sub_obj(sub_id: str, user_id: str, status: str = "active", **extra) -> dict:
    return {
        "id": sub_id,
        "customer": "cus_o",
        "status": status,
        "cancel_at_period_end": False,
        "current_period_end": T0 + 30 * 86400,
        "metadata": {"user_id": user_id, "plan": "private", "interval": "monthly"},
        **extra,
    }


def _checkout_obj(sub_id: str, user_id: str, payment_status: str = "paid") -> dict:
    return {
        "id": f"cs_{sub_id}",
        "mode": "subscription",
        "payment_status": payment_status,
        "client_reference_id": user_id,
        "customer": "cus_o",
        "subscription": sub_id,
        "metadata": {"user_id": user_id, "plan": "private", "interval": "monthly"},
    }


def _row(sub_id: str) -> Subscription:
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.external_id == sub_id))
        assert row is not None
        db.expunge(row)
        return row


def _plan(client) -> str:
    return client.get("/api/billing/entitlements").json()["plan"]


# --- 1. Webhook ordering ---------------------------------------------------------------


def test_an_old_active_event_delivered_after_the_deletion_never_reopens_the_plan() -> None:
    client, user_id = member("ord1")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    assert post_event(client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0))
    r = post_event(
        client,
        _event("customer.subscription.deleted", _sub_obj(sub, user_id, "canceled"), T0 + 300),
    )
    assert r.json()["outcome"] == "canceled"
    # Stripe retries an older "updated: active" late: skipped.
    late = post_event(
        client, _event("customer.subscription.updated", _sub_obj(sub, user_id), T0 + 100)
    )
    assert late.json()["outcome"] == "stale"
    # Even a newer-stamped one can't reopen it: Stripe never revives a canceled subscription.
    newer = post_event(
        client, _event("customer.subscription.updated", _sub_obj(sub, user_id), T0 + 900)
    )
    assert newer.json()["outcome"] == "stale"
    assert _row(sub).status == "canceled"
    assert _plan(client) == "free"


def test_a_late_checkout_completion_keeps_what_the_subscription_events_said() -> None:
    client, user_id = member("ord2")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    cancelling = _sub_obj(sub, user_id, cancel_at_period_end=True)
    post_event(client, _event("customer.subscription.updated", cancelling, T0 + 200))
    assert _row(sub).cancel_at_period_end is True
    r = post_event(client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0))
    assert r.json()["outcome"] == "subscribed"
    row = _row(sub)
    assert row.cancel_at_period_end is True and row.renews_at is not None
    assert _plan(client) == "private"


def test_a_subscription_created_dated_before_its_checkout_still_sets_the_renewal() -> None:
    """Invariant: the plan row reflects what Stripe holds (October 28, 2026). Stripe dates the
    subscription's creation before the checkout's completion and may deliver it after; the
    checkout stamped its own date as the row's newest event, so the creation was skipped as
    stale and the renewal date stayed empty."""
    client, user_id = member("ord4")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    r = post_event(
        client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0 + 5)
    )
    assert r.json()["outcome"] == "subscribed"
    assert _row(sub).renews_at is None  # the checkout doesn't know the period
    r = post_event(client, _event("customer.subscription.created", _sub_obj(sub, user_id), T0))
    assert r.json()["outcome"] == "active"
    assert _row(sub).renews_at == datetime.fromtimestamp(T0 + 30 * 86400, tz=UTC)
    assert _plan(client) == "private"


def test_events_in_order_still_move_the_plan_along() -> None:
    client, user_id = member("ord3")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0))
    post_event(
        client, _event("customer.subscription.updated", _sub_obj(sub, user_id, "past_due"), T0 + 10)
    )
    assert _row(sub).status == "past_due"
    post_event(client, _event("customer.subscription.updated", _sub_obj(sub, user_id), T0 + 20))
    assert _row(sub).status == "active"


# --- 5a. Only a paid checkout grants a plan ------------------------------------------------


def test_an_unpaid_checkout_grants_nothing() -> None:
    client, user_id = member("unpaid")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    r = post_event(
        client, _event("checkout.session.completed", _checkout_obj(sub, user_id, "unpaid"), T0)
    )
    assert r.status_code == 200 and r.json()["outcome"] == "pending"
    assert _plan(client) == "free"


# --- 2. Refunds a retry can't pay twice ------------------------------------------------------


class RefundStripe:
    """Charges and refunds that remember what happened. `timeout_after_refund` applies the
    next refund at Stripe and then fails the call, as a network timeout would."""

    def __init__(self, charges: list[tuple[str, int]], balance: int = 0) -> None:
        self.charges = {
            cid: {"id": cid, "created": n, "amount": amt, "amount_refunded": 0}
            for n, (cid, amt) in enumerate(charges, start=1)
        }
        self.balance = balance
        self.refunds: list[dict] = []
        self.timeout_after_refund = 0
        self.intents: dict[str, int] = {}
        self.method = "card"  # or "us_bank_account"

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            path, q = request.url.path, dict(request.url.params)
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if path.endswith("/balance_transactions"):
                self.balance += int(form["amount"])
                return httpx2.Response(200, json={"id": "cbtxn"})
            if path.startswith("/v1/customers/"):
                return httpx2.Response(200, json={"id": "cus", "balance": self.balance})
            if path.startswith("/v1/payment_intents/"):
                charge = {"payment_method_details": {"type": self.method}}
                return httpx2.Response(200, json={"latest_charge": charge})
            if path == "/v1/charges":
                data = [
                    {
                        **c,
                        "paid": True,
                        "status": "succeeded",
                        "amount_captured": c["amount"],
                        "payment_method_details": {"type": self.method},
                    }
                    for c in self.charges.values()
                ]
                return httpx2.Response(200, json={"data": data})
            if path == "/v1/refunds" and request.method == "GET":
                data = [
                    r
                    for r in self.refunds
                    if r.get("charge") == q.get("charge", "-")
                    or r.get("payment_intent") == q.get("payment_intent", "-")
                ]
                return httpx2.Response(200, json={"data": data})
            if path == "/v1/refunds":
                refund = {
                    "id": f"re_{len(self.refunds)}",
                    "amount": int(form["amount"]),
                    "status": "succeeded",
                    "metadata": {"qash_refund": form.get("metadata[qash_refund]")},
                }
                if "charge" in form:
                    charge = self.charges[form["charge"]]
                    room = charge["amount"] - charge["amount_refunded"]
                    if refund["amount"] > room:
                        return httpx2.Response(400, json={"error": "amount_too_large"})
                    charge["amount_refunded"] += refund["amount"]
                    refund["charge"] = form["charge"]
                else:
                    refund["payment_intent"] = form["payment_intent"]
                    self.intents[form["payment_intent"]] = (
                        self.intents.get(form["payment_intent"], 0) + refund["amount"]
                    )
                self.refunds.append(refund)
                if self.timeout_after_refund:
                    self.timeout_after_refund -= 1
                    return httpx2.Response(500, json={"error": "timeout"})
                return httpx2.Response(200, json=refund)
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)

    def total(self) -> int:
        return sum(r["amount"] for r in self.refunds)


def test_a_retry_after_a_timeout_pays_only_what_is_still_owed() -> None:
    # Owed: $40.00 credit + $60.00 for unused months = $100.00, less the fee 2.9% + 30¢ = $96.80.
    fake = RefundStripe([("ch_old", 5000), ("ch_new", 6000)], balance=-4000)
    stripe_billing.transport_override = fake.transport()
    owed = 10000 - stripe_billing.refund_fee_cents(10000)
    fake.timeout_after_refund = 1  # ch_new refunded at Stripe, but the call fails
    with pytest.raises(stripe_billing.BillingError):
        stripe_billing.refund_credit("cus", key="closeout:u1", extra_cents=6000)
    assert fake.total() == 6000  # ch_new, all of its room
    # The retry, as the purge would run it later.
    assert stripe_billing.refund_credit("cus", key="closeout:u1", extra_cents=6000) == owed
    assert fake.total() == owed  # not a cent more
    assert sorted(r["charge"] for r in fake.refunds) == ["ch_new", "ch_old"]  # once each
    assert fake.balance == 0  # the credit cleared once
    # A third run (say the database never recorded the success) refunds nothing more.
    stripe_billing.refund_credit("cus", key="closeout:u1", extra_cents=6000)
    assert fake.total() == owed and fake.balance == 0


def test_a_founding_refund_is_paid_once_however_often_it_is_retried() -> None:
    fake = RefundStripe([])
    stripe_billing.transport_override = fake.transport()
    fake.timeout_after_refund = 1
    with pytest.raises(stripe_billing.BillingError):
        stripe_billing.refund_payment("pi_f", 9000, key="founding:x")
    stripe_billing.refund_payment("pi_f", 9000, key="founding:x")
    stripe_billing.refund_payment("pi_f", 8000, key="founding:x")  # worked out again: still once
    assert len(fake.refunds) == 1
    assert fake.intents["pi_f"] == 9000 - stripe_billing.refund_fee_cents(9000)


# --- 4. The Founding cap ------------------------------------------------------------------------


def test_a_founding_checkout_page_expires_in_about_30_minutes() -> None:
    client, _ = member("fexp")
    fake = FakeStripe()
    stripe_billing.transport_override = fake.transport()
    r = client.post("/api/billing/checkout", json=buy(client, plan="founding"))
    assert r.status_code == 200, r.text
    form = {k: v[0] for k, v in parse_qs(fake.requests[-1].content.decode()).items()}
    left = int(form["expires_at"]) - datetime.now(UTC).timestamp()
    assert 30 * 60 < left <= 31 * 60
    sub_form = [k for k in form if k.startswith("expires_at")]
    assert sub_form == ["expires_at"]
    assert form["customer_creation"] == "always"  # so receipts open in the portal


def test_a_founding_payment_after_the_last_place_is_refunded_in_full(monkeypatch) -> None:
    plans = copy.deepcopy(stripe_billing.load_plans())
    plans["founding"]["cap"] = 1
    monkeypatch.setattr(stripe_billing, "load_plans", lambda: plans)
    first, first_id = member("fone")
    grant_plan(first_id, "founding")  # the last place
    late, late_id = member("flate")
    fake = RefundStripe([])
    stripe_billing.transport_override = fake.transport()
    paid = {
        "id": "cs_late",
        "mode": "payment",
        "payment_status": "paid",
        "client_reference_id": late_id,
        "customer": "cus_late",
        "payment_intent": "pi_late",
        "metadata": {"user_id": late_id, "plan": "founding"},
    }
    r = post_event(late, _event("checkout.session.completed", paid, T0))
    assert r.status_code == 200 and r.json()["outcome"] == "founding_sold_out"
    assert fake.intents == {"pi_late": 15000}  # in full: our timing, so no fee taken
    assert _plan(late) == "free"
    assert outbox()[-1].subject == "The Founding offer filled up, so we've refunded you"
    # Stripe sends it again under a new event id: no second refund.
    post_event(late, _event("checkout.session.completed", paid, T0))
    assert len(fake.refunds) == 1
    assert _plan(first) == "founding"


def test_a_subscription_stripe_ends_after_failed_payments_stops_at_once() -> None:
    """Dunning ends it mid-period: the period end has already moved ahead a month."""
    client, user_id = member("dunning")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0))
    post_event(
        client, _event("customer.subscription.updated", _sub_obj(sub, user_id, "past_due"), T0 + 10)
    )
    assert _plan(client) == "private"  # past due keeps working while Stripe retries
    ended = _sub_obj(sub, user_id, "canceled", ended_at=int(time.time()) - 5)
    post_event(client, _event("customer.subscription.deleted", ended, T0 + 20))
    assert _plan(client) == "free"


def test_a_delayed_payment_starts_the_plan_when_the_money_arrives() -> None:
    client, user_id = member("async")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    pending = _checkout_obj(sub, user_id, "unpaid")
    assert (
        post_event(client, _event("checkout.session.completed", pending, T0)).json()["outcome"]
        == "pending"
    )
    assert _plan(client) == "free"
    paid = _checkout_obj(sub, user_id, "paid")
    r = post_event(client, _event("checkout.session.async_payment_succeeded", paid, T0 + 60))
    assert r.json()["outcome"] == "subscribed"
    assert _plan(client) == "private"


# --- US bank accounts (owner decision, October 24, 2026) -----------------------------------


def _founding_obj(user_id: str, pi: str, payment_status: str) -> dict:
    return {
        "id": f"cs_{pi}",
        "mode": "payment",
        "payment_status": payment_status,
        "client_reference_id": user_id,
        "customer": f"cus_{pi}",
        "payment_intent": pi,
        "metadata": {"user_id": user_id, "plan": "founding"},
    }


def _places(client) -> int:
    return client.get("/api/billing").json()["founding"]["left"]


def test_a_founding_bank_payment_holds_its_place_then_starts_when_it_clears() -> None:
    client, user_id = member("fbank")
    before = _places(client)
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    r = post_event(
        client, _event("checkout.session.completed", _founding_obj(user_id, pi, "unpaid"), T0)
    )
    assert r.json()["outcome"] == "pending"
    assert _plan(client) == "free" and _places(client) == before - 1  # held while it clears
    r = post_event(
        client,
        _event(
            "checkout.session.async_payment_succeeded", _founding_obj(user_id, pi, "paid"), T0 + 60
        ),
    )
    assert r.json()["outcome"] == "founding"
    assert _plan(client) == "founding" and _places(client) == before - 1


def test_a_failed_founding_bank_payment_gives_the_place_back_and_says_so() -> None:
    client, user_id = member("fbankfail")
    before = _places(client)
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    post_event(
        client, _event("checkout.session.completed", _founding_obj(user_id, pi, "unpaid"), T0)
    )
    outbox().clear()
    r = post_event(
        client,
        _event(
            "checkout.session.async_payment_failed", _founding_obj(user_id, pi, "unpaid"), T0 + 60
        ),
    )
    assert r.json()["outcome"] == "payment_failed"
    assert _plan(client) == "free" and _places(client) == before
    assert outbox()[-1].subject == "Your bank payment didn't go through"
    assert "$" not in outbox()[-1].text


def test_a_bank_refund_keeps_the_bank_fee_not_the_card_fee() -> None:
    assert stripe_billing.refund_fee_cents(6500, "bank") == 52  # 0.8%
    assert stripe_billing.refund_fee_cents(150000, "bank") == 500  # capped at $5
    fake = RefundStripe([("ch_b", 6500)])
    fake.method = "us_bank_account"
    stripe_billing.transport_override = fake.transport()
    assert stripe_billing.refund_credit("cus", key="closeout:bank", extra_cents=6500) == 6500 - 52


# --- Disputes (owner decision, October 24, 2026) ---------------------------------------------


class DisputeStripe:
    def __init__(self, customer: str) -> None:
        self.customer = customer
        self.canceled: list[str] = []

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            if request.url.path.startswith("/v1/charges/"):
                return httpx2.Response(200, json={"id": "ch_d", "customer": self.customer})
            if request.method == "DELETE" and request.url.path.startswith("/v1/subscriptions/"):
                self.canceled.append(request.url.path.rsplit("/", 1)[-1])
                return httpx2.Response(200, json={"status": "canceled"})
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def _dispute(kind: str, status: str = "needs_response") -> dict:
    obj = {
        "id": f"dp_{uuid.uuid4().hex[:6]}",
        "charge": "ch_d",
        "payment_intent": "pi_x",
        "status": status,
    }
    return _event(kind, obj, int(time.time()))


def _subscribed(name: str) -> tuple:
    client, user_id = member(name)
    grant_plan(user_id, "connected")
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None
        return client, user_id, row.customer_id, row.external_id


def test_a_dispute_pauses_the_plan_and_winning_it_brings_it_back(monkeypatch) -> None:
    from app.config import get_settings

    client, user_id, customer, _ = _subscribed("dispute")
    monkeypatch.setattr(get_settings(), "admin_emails", ["owner@example.com"])
    stripe_billing.transport_override = DisputeStripe(customer).transport()
    outbox().clear()
    r = post_event(client, _dispute("charge.dispute.created"))
    assert r.json()["outcome"] == "disputed"
    state = client.get("/api/billing/entitlements").json()
    assert state["plan"] == "free" and state["access"]["state"] == "paused"
    sent = {(m.to, m.subject) for m in outbox()}
    assert ("owner@example.com", "A Qash payment was disputed") in sent
    assert any(s == "Your Qash plan is paused while a payment is disputed" for _, s in sent)
    # Paused is never deleted for it, however long it lasts.
    from datetime import timedelta

    from app.jobs import plan_lifecycle

    with get_session_factory()() as db:
        counts = plan_lifecycle.run(
            db, now=datetime.now(UTC) + timedelta(days=60), only={uuid.UUID(user_id)}
        )
    assert counts["deleted"] == 0
    r = post_event(client, _dispute("charge.dispute.closed", "won"))
    assert r.json()["outcome"] == "dispute_won"
    assert _plan(client) == "connected"
    assert outbox()[-1].subject == "Your Qash plan is back"


def test_a_lost_dispute_ends_the_subscription_so_nothing_is_charged_again() -> None:
    client, _, customer, sub_id = _subscribed("lost")
    fake = DisputeStripe(customer)
    stripe_billing.transport_override = fake.transport()
    post_event(client, _dispute("charge.dispute.created"))
    r = post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert r.json()["outcome"] == "dispute_lost"
    assert fake.canceled == [sub_id]
    assert _plan(client) == "free"
    # Lost is final: not paused (which says the plan comes back by itself) but ended, and the
    # account stays open (owner decision, October 25, 2026).
    assert client.get("/api/billing/entitlements").json()["access"]["state"] == "ended"


def test_a_lost_dispute_ends_the_plan_but_the_account_stays_open_and_is_never_closed() -> None:
    """The terms: "Nothing is deleted because of a dispute" (owner decision, October 25, 2026)."""
    from datetime import timedelta

    from app.jobs import plan_lifecycle
    from app.models.user import User

    client, user_id, customer, sub_id = _subscribed("lostlife")
    stripe_billing.transport_override = DisputeStripe(customer).transport()
    post_event(client, _dispute("charge.dispute.created"))
    outbox().clear()
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    [note] = outbox()
    assert note.subject == "Your Qash plan has ended"
    assert "account stays open" in note.text and "$" not in note.text
    outbox().clear()
    for n in (1, 2, 8, 60, 400):
        with get_session_factory()() as db:
            counts = plan_lifecycle.run(
                db, now=datetime.now(UTC) + timedelta(days=n), only={uuid.UUID(user_id)}
            )
        assert counts == {"ending_soon": 0, "ended": 0, "reminded": 0, "deleted": 0}
    assert outbox() == []  # no reminders, no closing
    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None and user.deleted_at is None
        row = db.scalar(select(Subscription).where(Subscription.external_id == sub_id))
        assert row is not None and row.disputed_at is not None  # deleting refunds nothing more
    assert client.get("/api/billing/entitlements").json()["access"]["state"] == "ended"


def test_a_fraud_refund_lapses_with_honest_notes_that_never_invite_buying_again() -> None:
    from datetime import timedelta

    from app.jobs import plan_lifecycle

    client, user_id, customer, _ = _subscribed("fraudlife")
    stripe_billing.transport_override = FraudStripe(customer).transport()
    post_event(client, _warning())
    who = {uuid.UUID(user_id)}

    def day(n: int) -> dict:
        with get_session_factory()() as db:
            return plan_lifecycle.run(
                db, now=datetime.now(UTC) + timedelta(days=n, hours=1), only=who
            )

    email = client.get("/api/auth/session").json()["user"]["email"]

    def mine() -> list:
        """The person's own mail. Anything else is the team's ops alert, which goes out once per
        kind an hour (`ops_alerts`), so whether one lands here depends on the tests before."""
        others = [m for m in outbox() if m.to != email]
        assert all(m.subject.startswith("Qash error:") for m in others), others
        return [m for m in outbox() if m.to == email]

    outbox().clear()
    assert day(0)["ended"] == 1
    [note] = mine()
    assert note.subject == "Your Qash plan has ended" and "Keep going" not in note.text
    assert day(1)["reminded"] == 0 and day(2)["reminded"] == 0
    outbox().clear()
    assert day(60)["deleted"] == 1
    [closed] = mine()
    assert "welcome back" not in closed.text.lower()


def test_a_lost_dispute_on_a_founding_payment_ends_it_too() -> None:
    client, user_id = member("lostfounding")
    grant_plan(user_id, "founding")
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None
        customer = row.customer_id
    stripe_billing.transport_override = DisputeStripe(customer).transport()
    post_event(client, _dispute("charge.dispute.created"))
    r = post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert r.json()["outcome"] == "dispute_lost"
    state = client.get("/api/billing/entitlements").json()
    assert state["plan"] == "free" and state["access"]["state"] == "ended"
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None and row.status == "canceled"


def test_stripe_calling_a_clearing_bank_subscription_active_grants_nothing_until_it_clears() -> (
    None
):
    """Found by the payments e2e (October 24, 2026): Stripe marks a subscription active while
    its first US bank debit is still clearing, and past due if it then fails."""
    client, user_id = member("achsub")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("customer.subscription.created", _sub_obj(sub, user_id), T0))
    post_event(
        client, _event("checkout.session.completed", _checkout_obj(sub, user_id, "unpaid"), T0 + 1)
    )
    assert _plan(client) == "free"
    assert client.get("/api/billing").json()["payment_pending"] is True
    post_event(
        client,
        _event("checkout.session.async_payment_succeeded", _checkout_obj(sub, user_id), T0 + 60),
    )
    assert _plan(client) == "private"
    assert client.get("/api/billing").json()["payment_pending"] is False


def test_a_failed_first_bank_payment_ends_the_subscription_at_stripe() -> None:
    client, user_id = member("achfail")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    fake = DisputeStripe("cus_o")  # records the cancellation
    stripe_billing.transport_override = fake.transport()
    post_event(client, _event("customer.subscription.created", _sub_obj(sub, user_id), T0))
    unpaid = _checkout_obj(sub, user_id, "unpaid")
    post_event(client, _event("checkout.session.completed", unpaid, T0 + 1))
    r = post_event(client, _event("checkout.session.async_payment_failed", unpaid, T0 + 60))
    assert r.json()["outcome"] == "payment_failed"
    assert fake.canceled == [sub]
    # Stripe's own past-due update arriving afterwards changes nothing.
    late = _sub_obj(sub, user_id, "past_due")
    post_event(client, _event("customer.subscription.updated", late, T0 + 61))
    assert _plan(client) == "free"
    assert client.get("/api/billing").json()["payment_pending"] is False


def test_a_subscription_stripe_marks_unpaid_stops_at_once() -> None:
    """Stripe's other end to failed payments: status unpaid, not deleted."""
    client, user_id = member("unpaidsub")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("checkout.session.completed", _checkout_obj(sub, user_id), T0))
    post_event(
        client, _event("customer.subscription.updated", _sub_obj(sub, user_id, "unpaid"), T0 + 10)
    )
    assert _plan(client) == "free"


# --- Disputes and deletion, early fraud warnings, buying again (October 24, 2026) ------------


def _dispute_now(user_id: str) -> None:
    with get_session_factory()() as db, db.begin():
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None
        row.disputed_at = datetime.now(UTC)


def test_deleting_with_a_disputed_payment_refunds_nothing_more() -> None:
    from app.services import deletion

    client, user_id = member("disputedel")
    grant_plan(user_id, "connected", interval="yearly")
    _dispute_now(user_id)
    fake = RefundStripe([("ch_y", 6500)], balance=-500)  # credit left from a downgrade, too
    stripe_billing.transport_override = fake.transport()
    with get_session_factory()() as db:
        assert deletion.refund_preview(db, uuid.UUID(user_id))[0] == 0
    shown = client.get("/api/billing/credit").json()
    assert (shown["refund_if_deleted_cents"], shown["refund_kind"]) == (0, "none")
    with get_session_factory()() as db, db.begin():
        assert deletion.cancel_billing(db, uuid.UUID(user_id)) is True
    assert fake.refunds == []  # the bank already returned the money: never paid twice


def test_a_refund_never_touches_a_disputed_charge() -> None:
    fake = RefundStripe([("ch_old", 6500), ("ch_new", 6500)])
    fake.charges["ch_new"]["disputed"] = True
    stripe_billing.transport_override = fake.transport()
    stripe_billing.refund_credit("cus", key="closeout:d", extra_cents=1000)
    assert {r["charge"] for r in fake.refunds} == {"ch_old"}


class FraudStripe:
    """A card charge with a fingerprint, its refunds, Stripe's block lists and cancellations."""

    def __init__(self, customer: str, amount: int = 6500) -> None:
        self.customer = customer
        self.amount = amount
        self.stripe_subs: list[dict] = []  # the customer's subscriptions as Stripe has them
        self.intent_owner = ""
        self.refunded = 0
        self.refunds: list[dict] = []
        self.blocked: list[dict] = []
        self.canceled: list[str] = []

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            path, q = request.url.path, dict(request.url.params)
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if path.startswith("/v1/charges/"):
                return httpx2.Response(
                    200,
                    json={
                        "id": path.rsplit("/", 1)[-1],
                        "customer": self.customer,
                        "amount": self.amount,
                        "amount_captured": self.amount,
                        "amount_refunded": self.refunded,
                        "payment_method_details": {
                            "type": "card",
                            "card": {"fingerprint": "fp_stolen"},
                        },
                    },
                )
            if path == "/v1/refunds" and request.method == "GET":
                return httpx2.Response(200, json={"data": self.refunds})
            if path.startswith("/v1/payment_intents/"):
                return httpx2.Response(200, json={"metadata": {"user_id": self.intent_owner}})
            if path == "/v1/subscriptions":
                return httpx2.Response(200, json={"data": self.stripe_subs})
            if path == "/v1/charges":
                charge = {
                    "id": "ch_late",
                    "created": int(time.time()),
                    "status": "succeeded",
                    "amount": self.amount,
                    "amount_captured": self.amount,
                    "amount_refunded": self.refunded,
                }
                return httpx2.Response(200, json={"data": [charge]})
            if path == "/v1/refunds":
                refund = {
                    "charge": form.get("charge"),
                    "amount": int(form["amount"]),
                    "reason": form["reason"],
                    "status": "succeeded",
                    "metadata": {"qash_refund": form["metadata[qash_refund]"]},
                }
                self.refunds.append(refund)
                self.refunded += refund["amount"]
                return httpx2.Response(200, json=refund)
            if path == "/v1/radar/value_lists":
                return httpx2.Response(200, json={"data": [{"id": f"rsl_{q['alias']}"}]})
            if path == "/v1/radar/value_list_items" and request.method == "GET":
                return httpx2.Response(200, json={"data": []})  # not listed yet
            if path == "/v1/radar/value_list_items":
                self.blocked.append(form)
                return httpx2.Response(200, json={"id": "rsli"})
            if request.method == "DELETE" and path.startswith("/v1/subscriptions/"):
                self.canceled.append(path.rsplit("/", 1)[-1])
                return httpx2.Response(200, json={"status": "canceled"})
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def _warning(actionable: bool = True) -> dict:
    obj = {
        "id": f"issfr_{uuid.uuid4().hex[:6]}",
        "object": "radar.early_fraud_warning",
        "actionable": actionable,
        "charge": "ch_f",
        "payment_intent": f"pi_{uuid.uuid4().hex[:8]}",  # a card plan is found by its customer
        "fraud_type": "unauthorized_use_of_card",
    }
    return _event("radar.early_fraud_warning.created", obj, int(time.time()))


def _try_to_buy(client) -> int:
    body = buy(client, plan="private", interval="yearly")
    return client.post("/api/billing/checkout", json=body).status_code


def test_an_early_fraud_warning_refunds_in_full_ends_the_plan_and_blocks_buying(
    monkeypatch,
) -> None:
    from app.config import get_settings

    client, user_id, customer, sub_id = _subscribed("fraud")
    monkeypatch.setattr(get_settings(), "admin_emails", ["owner@example.com"])
    fake = FraudStripe(customer)
    stripe_billing.transport_override = fake.transport()
    outbox().clear()
    r = post_event(client, _warning())
    assert r.json()["outcome"] == "fraud_refunded"
    assert [(x["amount"], x["reason"]) for x in fake.refunds] == [(6500, "fraudulent")]
    assert fake.canceled == [sub_id]
    assert _plan(client) == "free"
    assert fake.blocked == [{"value_list": "rsl_card_fingerprint_blocklist", "value": "fp_stolen"}]
    sent = {m.subject for m in outbox()}
    assert "We refunded a Qash payment and ended your plan" in sent
    assert "A Qash payment was refunded on a fraud warning" in sent
    assert not any("$" in m.text for m in outbox())
    # Stripe redelivers under a new event id: nothing is refunded twice.
    post_event(client, _warning())
    assert len(fake.refunds) == 1
    assert _try_to_buy(client) == 403


def test_a_warning_stripe_says_needs_no_action_changes_nothing() -> None:
    client, _, customer, _ = _subscribed("nofraud")
    fake = FraudStripe(customer)
    stripe_billing.transport_override = fake.transport()
    assert post_event(client, _warning(actionable=False)).json()["outcome"] == "ignored"
    assert fake.refunds == [] and fake.canceled == []
    assert _plan(client) == "connected"


def test_after_a_lost_dispute_the_inbox_and_card_cannot_buy_again() -> None:
    from app.services.otp import canonical_email

    client, _, customer, _ = _subscribed("kept")
    fake = FraudStripe(customer)
    stripe_billing.transport_override = fake.transport()
    post_event(client, _dispute("charge.dispute.created"))
    assert _try_to_buy(client) != 403  # an open dispute alone blocks nothing
    post_event(client, _dispute("charge.dispute.closed", "lost"))
    assert fake.blocked == [{"value_list": "rsl_card_fingerprint_blocklist", "value": "fp_stolen"}]
    assert _try_to_buy(client) == 403
    assert (
        client.post(
            "/api/billing/checkout",
            json={"plan": "private", "interval": "yearly", "consent": CONSENT},
        ).json()["detail"]
        == "purchase_blocked"
    )
    # The same inbox under a +tag is the same person.
    email = client.get("/api/auth/session").json()["user"]["email"]
    with get_session_factory()() as db:
        assert stripe_billing.inbox_blocked(db, email.replace("@", "+again@"))
        assert canonical_email(email.replace("@", "+again@")) == canonical_email(email)


def test_a_won_dispute_blocks_nothing() -> None:
    client, _, customer, _ = _subscribed("wonback")
    stripe_billing.transport_override = FraudStripe(customer).transport()
    post_event(client, _dispute("charge.dispute.created"))
    post_event(client, _dispute("charge.dispute.closed", "won"))
    with get_session_factory()() as db:
        email = client.get("/api/auth/session").json()["user"]["email"]
        assert not stripe_billing.inbox_blocked(db, email)


def test_a_fraud_warning_before_the_checkout_webhook_still_ends_it_and_grants_nothing() -> None:
    client, user_id = member("early")
    fake = FraudStripe("cus_early")
    fake.stripe_subs = [{"id": "sub_early", "status": "active", "metadata": {"user_id": user_id}}]
    stripe_billing.transport_override = fake.transport()
    outbox().clear()
    r = post_event(client, _warning())  # no plan row here yet
    assert r.json()["outcome"] == "fraud_refunded"
    assert fake.canceled == ["sub_early"] and len(fake.refunds) == 1
    assert "We refunded a Qash payment and ended your plan" in {m.subject for m in outbox()}
    # The checkout's own completion lands afterwards: nothing is granted or refunded again.
    obj = {**_checkout_obj("sub_early", user_id), "customer": "cus_early", "created": T0}
    r = post_event(client, _event("checkout.session.completed", obj, int(time.time())))
    assert r.json()["outcome"] == "blocked"
    assert _plan(client) == "free"
    assert len(fake.refunds) == 1  # the fraud refund already covered it


def test_a_blocked_inbox_whose_checkout_still_completes_is_refunded_in_full() -> None:
    client, user_id = member("lateblock")
    with get_session_factory()() as db, db.begin():
        stripe_billing.block_purchases(db, uuid.UUID(user_id), "dispute_lost")
    fake = FraudStripe("cus_o")
    stripe_billing.transport_override = fake.transport()
    obj = {**_checkout_obj("sub_late", user_id), "created": T0}
    r = post_event(client, _event("checkout.session.completed", obj, int(time.time())))
    assert r.json()["outcome"] == "blocked"
    assert fake.canceled == ["sub_late"]
    assert [(x["charge"], x["amount"]) for x in fake.refunds] == [("ch_late", 6500)]
    assert _plan(client) == "free"


# --- One Founding count everywhere (October 25, 2026) -----------------------------------------


def _one_place_left(monkeypatch) -> None:
    """Set the cap so exactly one Founding place is left, whatever other tests bought."""
    from app.rules_server import entitlements

    with get_session_factory()() as db:
        cap, left = entitlements.founding_left(db)
    plans = copy.deepcopy(entitlements.load_plans())
    plans["founding"]["cap"] = cap - left + 1
    monkeypatch.setattr(entitlements, "load_plans", lambda: plans)
    monkeypatch.setattr(stripe_billing, "load_plans", lambda: plans)


def test_a_failed_bank_payment_never_shrinks_the_cap_a_card_buyer_gets_the_last_place(
    monkeypatch,
) -> None:
    _one_place_left(monkeypatch)
    bank, bank_id = member("fcapbank")
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    post_event(bank, _event("checkout.session.completed", _founding_obj(bank_id, pi, "unpaid"), T0))
    post_event(
        bank,
        _event(
            "checkout.session.async_payment_failed", _founding_obj(bank_id, pi, "unpaid"), T0 + 60
        ),
    )
    assert _places(bank) == 1  # the pricing side: the place came back
    card, card_id = member("fcapcard")
    stripe_billing.transport_override = RefundStripe([]).transport()
    paid = _founding_obj(card_id, f"pi_{uuid.uuid4().hex[:8]}", "paid")
    r = post_event(card, _event("checkout.session.completed", paid, T0 + 120))
    assert r.json()["outcome"] == "founding"  # the webhook side agrees: not "sold out"
    assert _plan(card) == "founding"
    assert _places(card) == 0


def test_two_buyers_paying_for_the_last_place_at_once_never_both_get_it(monkeypatch) -> None:
    """The count and the insert happen under one lock for the whole offer, so a second buyer
    waits for the first and is refunded rather than sold a place that isn't there."""
    import threading

    from sqlalchemy import text

    from app.models.billing import Subscription

    _one_place_left(monkeypatch)
    late, late_id = member("fracelate")
    fake = RefundStripe([])
    stripe_billing.transport_override = fake.transport()
    _, first_id = member("fracefirst")
    factory = get_session_factory()
    result: list = []
    with factory() as first:
        # The first buyer's webhook is mid-way: it holds the offer's lock and takes the place.
        first.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": stripe_billing.FOUNDING_LOCK})
        first.add(
            Subscription(
                user_id=uuid.UUID(first_id),
                plan="founding",
                source="stripe",
                external_id=f"pi_{uuid.uuid4().hex[:8]}",
                customer_id="cus_first",
                status="active",
                interval=None,
            )
        )
        first.flush()
        paid = _founding_obj(late_id, f"pi_{uuid.uuid4().hex[:8]}", "paid")
        worker = threading.Thread(
            target=lambda: result.append(
                post_event(late, _event("checkout.session.completed", paid, T0)).json()
            )
        )
        worker.start()
        time.sleep(1.0)
        assert result == []  # the second buyer waits for the first
        first.commit()
    worker.join(timeout=30)
    assert result and result[0]["outcome"] == "founding_sold_out"
    assert _plan(late) == "free"
    assert len(fake.refunds) == 1


def test_a_payment_whose_place_was_given_back_passes_the_cap_again_before_it_is_granted(
    monkeypatch,
) -> None:
    """Every grant passes the cap: a failed bank payment (expired) gave its place back, so if
    Stripe ever reports that same payment as paid, it is counted again, not waved through."""
    _one_place_left(monkeypatch)
    bank, bank_id = member("fexpired")
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    post_event(bank, _event("checkout.session.completed", _founding_obj(bank_id, pi, "unpaid"), T0))
    post_event(
        bank,
        _event(
            "checkout.session.async_payment_failed", _founding_obj(bank_id, pi, "unpaid"), T0 + 60
        ),
    )
    other, other_id = member("ftooklast")
    grant_plan(other_id, "founding")  # meanwhile someone took the place back
    fake = RefundStripe([])
    stripe_billing.transport_override = fake.transport()
    r = post_event(
        bank,
        _event(
            "checkout.session.async_payment_succeeded", _founding_obj(bank_id, pi, "paid"), T0 + 120
        ),
    )
    assert r.json()["outcome"] == "founding_sold_out"
    assert _plan(bank) == "free" and _plan(other) == "founding"
    assert fake.intents == {pi: 15000}


# --- Same-second events (October 25, 2026) ----------------------------------------------------


class CurrentSubscription:
    """Stripe's GET /v1/subscriptions/{id}: the subscription as it is now."""

    def __init__(self, obj: dict) -> None:
        self.obj = obj
        self.fetched = 0

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            if (
                request.method == "GET"
                and request.url.path == f"/v1/subscriptions/{self.obj['id']}"
            ):
                self.fetched += 1
                return httpx2.Response(200, json=self.obj)
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


@pytest.mark.parametrize("truth", [False, True])
def test_two_events_in_the_same_second_apply_what_stripe_holds_now(truth: bool) -> None:
    """Stripe dates events to the second and may deliver them in any order: a cancel and a
    resume in the same second can't be ordered by date, so the subscription is read from Stripe."""
    client, user_id = member("samesecond")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("customer.subscription.created", _sub_obj(sub, user_id), T0))
    cancel = _sub_obj(sub, user_id, cancel_at_period_end=True)
    resume = _sub_obj(sub, user_id, cancel_at_period_end=False)
    stripe = CurrentSubscription(_sub_obj(sub, user_id, cancel_at_period_end=truth))
    stripe_billing.transport_override = stripe.transport()
    # Delivered in the opposite order to the truth: the last one to arrive is the wrong one
    first, last = (resume, cancel) if not truth else (cancel, resume)
    post_event(client, _event("customer.subscription.updated", first, T0 + 10))
    post_event(client, _event("customer.subscription.updated", last, T0 + 10))
    assert _row(sub).cancel_at_period_end is truth
    assert stripe.fetched >= 1


def test_an_older_event_is_still_skipped_without_asking_stripe() -> None:
    client, user_id = member("olderskip")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    post_event(client, _event("customer.subscription.created", _sub_obj(sub, user_id), T0))
    stripe = CurrentSubscription(_sub_obj(sub, user_id))
    stripe_billing.transport_override = stripe.transport()
    post_event(client, _event("customer.subscription.updated", _sub_obj(sub, user_id), T0 + 20))
    late = _sub_obj(sub, user_id, cancel_at_period_end=True)
    r = post_event(client, _event("customer.subscription.updated", late, T0 + 5))
    assert r.json()["outcome"] == "stale"
    assert _row(sub).cancel_at_period_end is False
    assert stripe.fetched == 0


# --- First bank payments delivered out of order (October 25, 2026) ----------------------------


class BankStripe:
    """Records cancellations; answers an invoice's status (open while a bank debit clears)."""

    def __init__(self, invoice_status: str = "open") -> None:
        self.canceled: list[str] = []
        self.invoice_status = invoice_status

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            if request.method == "DELETE" and request.url.path.startswith("/v1/subscriptions/"):
                self.canceled.append(request.url.path.rsplit("/", 1)[-1])
                return httpx2.Response(200, json={"status": "canceled"})
            if request.method == "GET" and request.url.path.startswith("/v1/invoices/"):
                inv = request.url.path.rsplit("/", 1)[-1]
                return httpx2.Response(200, json={"id": inv, "status": self.invoice_status})
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def test_a_failed_first_bank_payment_delivered_before_its_checkout_still_ends_it_at_stripe() -> (
    None
):
    client, user_id = member("achearly")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    fake = BankStripe()
    stripe_billing.transport_override = fake.transport()
    unpaid = _checkout_obj(sub, user_id, "unpaid")
    # The completion's delivery kept failing, so the failure arrives first
    r = post_event(client, _event("checkout.session.async_payment_failed", unpaid, T0 + 60))
    assert r.json()["outcome"] == "payment_failed"
    assert fake.canceled == [sub]  # Stripe stops retrying the debit: nothing is ever taken
    post_event(client, _event("checkout.session.completed", unpaid, T0))
    post_event(client, _event("customer.subscription.updated", _sub_obj(sub, user_id), T0 + 61))
    assert _plan(client) == "free"
    assert client.get("/api/billing").json()["payment_pending"] is False  # not "on its way"


def test_a_failed_founding_bank_payment_delivered_first_never_holds_a_place() -> None:
    client, user_id = member("fachearly")
    before = _places(client)
    pi = f"pi_{uuid.uuid4().hex[:8]}"
    unpaid = _founding_obj(user_id, pi, "unpaid")
    post_event(client, _event("checkout.session.async_payment_failed", unpaid, T0 + 60))
    post_event(client, _event("checkout.session.completed", unpaid, T0))
    assert _places(client) == before
    assert _plan(client) == "free"


def test_a_bank_funded_subscription_announced_before_its_checkout_waits_for_the_money() -> None:
    client, user_id = member("achsubfirst")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    stripe_billing.transport_override = BankStripe("open").transport()
    created = _sub_obj(sub, user_id, latest_invoice="in_ach")
    post_event(client, _event("customer.subscription.created", created, T0))
    assert _plan(client) == "free"  # Stripe calls it active, but the debit hasn't cleared
    unpaid = _checkout_obj(sub, user_id, "unpaid")
    post_event(client, _event("checkout.session.completed", unpaid, T0 + 1))
    assert _plan(client) == "free"
    post_event(
        client,
        _event("checkout.session.async_payment_succeeded", _checkout_obj(sub, user_id), T0 + 90),
    )
    assert _plan(client) == "private"


def test_a_card_funded_subscription_announced_first_starts_at_once() -> None:
    client, user_id = member("cardsubfirst")
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    stripe_billing.transport_override = BankStripe("paid").transport()
    created = _sub_obj(sub, user_id, latest_invoice="in_card")
    post_event(client, _event("customer.subscription.created", created, T0))
    assert _plan(client) == "private"


def test_a_dispute_on_a_charge_no_plan_matches_still_reaches_the_admins(monkeypatch) -> None:
    """Already refunded, refused as blocked, or the account purged: Stripe still wants evidence
    before its deadline, so the admins are told whatever the app finds (October 27, 2026)."""
    from app.config import get_settings

    client, _ = member("nomatch")
    monkeypatch.setattr(get_settings(), "admin_emails", ["owner@example.com"])
    stripe_billing.transport_override = DisputeStripe("cus_nobody").transport()
    outbox().clear()
    r = post_event(client, _dispute("charge.dispute.created"))
    assert r.status_code == 200, r.text
    told = [m for m in outbox() if m.to == "owner@example.com"]
    assert [m.subject for m in told] == ["A Qash payment was disputed"]
    assert "paused" not in told[0].text  # no plan was found to pause
    assert "Stripe Dashboard" in told[0].text and "$" not in told[0].text


def test_a_founding_payment_disputed_after_its_deletion_never_holds_up_the_purge() -> None:
    """Stripe was unreachable at the deletion, so the refund waited; then the payment was
    disputed. The bank has the money, so nothing more is refunded and the account goes
    (October 27, 2026) instead of retrying a refund Stripe refuses for ever."""
    from datetime import timedelta

    from app.models.user import User
    from app.services.deletion import purge_due, soft_delete
    from tests.test_billing import CancelStripe

    client, user_id = member("lateDispute")
    grant_plan(user_id, "founding")
    refunds: list[str] = []
    base = CancelStripe().transport()

    def handle(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST" and request.url.path == "/v1/refunds":
            refunds.append(request.url.path)
            return httpx2.Response(400, json={"error": {"code": "charge_disputed"}})
        if request.url.path.startswith("/v1/payment_intents/"):
            return httpx2.Response(200, json={"payment_method_types": ["card"]})
        return base.handle_request(request)

    stripe_billing.transport_override = httpx2.MockTransport(handle)
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert row is not None
        row.refund_due_cents = 9000  # worked out at the deletion, not yet paid
        row.disputed_at = datetime.now(UTC)  # the dispute came in meanwhile
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        soft_delete(db, user)
        db.commit()
        purge_due(db, grace_days=30, now=datetime.now(UTC) + timedelta(days=31))
        db.commit()
        assert db.get(User, uuid.UUID(user_id)) is None
    assert refunds == []  # never tried to refund a disputed payment


def test_billing_routes_that_call_stripe_are_rate_limited() -> None:
    from app.security.rate_limit import LIMITS

    client, user_id = member("hammer")
    grant_plan(user_id, "private")
    limit = LIMITS["billing_stripe"].max_hits
    codes = [client.get("/api/billing/credit").status_code for _ in range(limit + 1)]
    assert codes[:limit] == [200] * limit
    assert codes[-1] == 429
