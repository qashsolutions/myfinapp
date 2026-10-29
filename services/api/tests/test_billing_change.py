"""Changing plans (owner decision, October 17, 2026): every switch happens at once. An upgrade
charges only the difference for the time left; a downgrade leaves the unused part as credit,
opens 30 days after the plan started or last changed, and disconnects banks when the new plan
doesn't link. Nobody ever ends up with two subscriptions. Deleting the account refunds the
unused part of what was paid."""

import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.linking import plaid
from app.models.billing import PurchaseConsent, Subscription
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import change_consent, grant_plan
from tests.conftest import stripe_default_transport
from tests.plaid_fake import FakePlaid
from tests.test_billing import FakeStripe as CheckoutStripe
from tests.test_billing import buy, member
from tests.test_billing_cancel import cancel_body
from tests.test_linking import start

NOW = int(time.time())
PERIOD_END = NOW + 20 * 86400
# A yearly period 100 days in: the current billing month ends on the 4-month anniversary.
YEAR_START = datetime(2026, 7, 9, 18, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    plaid.transport_override = None
    yield
    stripe_billing.transport_override = None
    plaid.transport_override = None


class FakeStripe:
    """Just enough of Stripe's subscriptions, previews, customers, charges and refunds."""

    def __init__(self, price: str) -> None:
        self.price = price
        self.decline = False
        self.cancel = False
        self.due, self.total = 512, 512  # what a preview says
        self.balance = 0  # Stripe keeps credit as a negative balance
        self.period = (NOW - 10 * 86400, PERIOD_END)  # (current_period_start, _end)
        self.charges = [
            {"id": "ch_old", "created": 1, "amount": 300, "amount_refunded": 0},
            {"id": "ch_new", "created": 2, "amount": 9288, "amount_refunded": 0},
        ]
        self.calls: list[tuple[str, str, dict[str, list[str]], str | None]] = []
        self.down = False  # Stripe unreachable: every call answers 503
        # No answer at all (a dropped connection, DNS, a timeout) for a call whose path holds
        # one of these; "" matches every call.
        self.unreachable: set[str] = set()

    def _sub(self, sub_id: str) -> dict:
        return {
            "id": sub_id,
            "customer": "cus_1",
            "status": "active",
            "cancel_at_period_end": self.cancel,
            "items": {
                "data": [
                    {
                        "id": "si_1",
                        "price": {"id": self.price},
                        "current_period_start": self.period[0],
                        "current_period_end": self.period[1],
                    }
                ]
            },
        }

    def paths(self, method: str = "POST") -> list[str]:
        return [path for m, path, _, _ in self.calls if m == method]

    def form(self, path: str) -> dict[str, str]:
        found = [f for _, p, f, _ in self.calls if p == path]
        return {k: v[0] for k, v in found[-1].items()}

    def refunds(self) -> list[tuple[str, int, str | None]]:
        return [
            (f.get("charge", f.get("payment_intent", [""]))[0], int(f["amount"][0]), key)
            for m, p, f, key in self.calls
            if m == "POST" and p == "/v1/refunds"
        ]

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            path = request.url.path
            form = parse_qs(request.content.decode())
            self.calls.append((request.method, path, form, request.headers.get("Idempotency-Key")))
            if any(part in path for part in self.unreachable):
                raise httpx2.ConnectError("no route to Stripe", request=request)
            if self.down:
                return httpx2.Response(503, json={"error": "down"})
            if path == "/v1/invoices/create_preview":
                if form.get("subscription_details[cancel_now]") == ["true"]:
                    return httpx2.Response(200, json={"total": -4000, "amount_due": 0})
                return httpx2.Response(
                    200,
                    json={
                        "amount_due": self.due,
                        "total": self.total,
                        "starting_balance": self.balance,
                        "ending_balance": min(0, self.balance + self.total),
                    },
                )
            if path.startswith("/v1/customers/") and path.endswith("/balance_transactions"):
                self.balance += int(form["amount"][0])
                return httpx2.Response(200, json={"id": "cbtxn_1"})
            if path.startswith("/v1/customers/"):
                return httpx2.Response(200, json={"id": "cus_1", "balance": self.balance})
            if path == "/v1/charges":
                return httpx2.Response(
                    200,
                    json={
                        "data": [
                            {
                                **c,
                                "paid": True,
                                "status": "succeeded",
                                "amount_captured": c["amount"],
                            }
                            for c in self.charges
                        ]
                    },
                )
            if path.startswith("/v1/payment_intents/"):
                card = {"payment_method_details": {"type": "card"}}
                return httpx2.Response(200, json={"latest_charge": card})
            if path == "/v1/refunds":
                return httpx2.Response(200, json={"id": "re_1"})
            if path.startswith("/v1/subscriptions/"):
                sub_id = path.rsplit("/", 1)[-1]
                if request.method == "DELETE":
                    return httpx2.Response(200, json={**self._sub(sub_id), "status": "canceled"})
                if "cancel_at_period_end" in form:
                    self.cancel = form["cancel_at_period_end"] == ["true"]
                if request.method == "POST" and "items[0][price]" in form:
                    if self.decline:
                        return httpx2.Response(402, json={"error": {"code": "card_declined"}})
                    self.price = form["items[0][price]"][0]
                    self.balance = min(0, self.balance + self.total)
                    # The switch's invoice, expanded as asked.
                    assert form["expand[0]"] == ["latest_invoice"]
                    invoice = {"id": "in_switch", "total": self.total}
                    return httpx2.Response(
                        200, json={**self._sub(sub_id), "latest_invoice": invoice}
                    )
                return httpx2.Response(200, json=self._sub(sub_id))
            return httpx2.Response(404, json={"error": "nope"})

        return httpx2.MockTransport(handle)


def row(user_id: str) -> Subscription:
    with get_session_factory()() as db:
        found = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert found is not None
        db.expunge(found)
        return found


def started_days_ago(user_id: str, days: int) -> None:
    with get_session_factory()() as db:
        found = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert found is not None
        found.created_at = datetime.now(UTC) - timedelta(days=days)
        db.commit()


def subscribed(name: str, plan: str, interval: str, price: str, *, days: int = 40):
    client, user_id = member(name)
    grant_plan(user_id, plan, interval=interval)
    started_days_ago(user_id, days)
    stripe = FakeStripe(price)
    stripe_billing.transport_override = stripe.transport()
    return client, user_id, stripe


def change(client, plan: str, interval: str, **extra):
    return client.post(
        "/api/billing/change",
        json={
            "plan": plan,
            "interval": interval,
            "consent": change_consent(client, plan, interval),
            **extra,
        },
    )


def test_checkout_never_opens_a_second_subscription() -> None:
    client, user_id, stripe = subscribed("twice", "private", "yearly", "price_private_y")
    r = client.post("/api/billing/checkout", json=buy(client, plan="connected", interval="monthly"))
    assert (r.status_code, r.json()["detail"]) == (409, "already_subscribed")
    r = client.post("/api/billing/checkout", json=buy(client, plan="founding"))
    assert (r.status_code, r.json()["detail"]) == (409, "cancel_first")
    assert not any(p == "/v1/checkout/sessions" for p in stripe.paths())
    # Once the plan is set not to renew, Founding (one payment, no renewal) may be bought.
    assert client.post("/api/billing/cancel", json=cancel_body(client)).status_code == 200
    stripe_billing.transport_override = CheckoutStripe().transport()
    assert (
        client.post("/api/billing/checkout", json=buy(client, plan="founding")).status_code == 200
    )
    r = client.post("/api/billing/checkout", json=buy(client, plan="private", interval="monthly"))
    assert r.json()["detail"] == "already_subscribed"  # still a live subscription until it ends


def test_an_upgrade_is_immediate_and_charges_only_the_difference() -> None:
    client, user_id, stripe = subscribed("up", "private", "monthly", "price_private_m", days=2)
    r = client.post(
        "/api/billing/change/preview", json={"plan": "connected", "interval": "monthly"}
    )
    assert r.status_code == 200, r.text
    preview = r.json()
    assert preview["kind"] == "up" and preview["due_now_cents"] == 512
    assert preview["credit_after_cents"] == 0 and preview["price_cents"] == 700
    asked = stripe.form("/v1/invoices/create_preview")
    assert asked["subscription_details[items][0][price]"] == "price_connected_m"
    assert asked["subscription_details[proration_behavior]"] == "always_invoice"

    mails = len(outbox())
    r = change(client, "connected", "monthly", proration_date=preview["proration_date"])
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "connected"
    sent = stripe.form(f"/v1/subscriptions/{row(user_id).external_id}")
    assert sent["items[0][id]"] == "si_1" and sent["items[0][price]"] == "price_connected_m"
    assert sent["proration_behavior"] == "always_invoice"
    assert sent["payment_behavior"] == "error_if_incomplete"
    assert sent["proration_date"] == str(preview["proration_date"])
    assert client.get("/api/billing/entitlements").json()["plan"] == "connected"
    assert len(outbox()) == mails + 1  # the always-on "your plan changed" alert
    latest = client.get("/api/billing/history").json()[0]
    assert (latest["kind"], latest["plan"], latest["amount_cents"]) == (
        "switched",
        "connected",
        stripe.total,
    )
    with get_session_factory()() as db:
        consent = db.scalar(
            select(PurchaseConsent).where(PurchaseConsent.user_id == uuid.UUID(user_id))
        )
    assert consent is not None and (consent.plan, consent.price_cents) == ("connected", 700)
    # Just changed: going back down waits 30 days; going further up never waits.
    assert r.json()["downgrade_from"] is not None
    r = client.post("/api/billing/change/preview", json={"plan": "private", "interval": "monthly"})
    assert (r.status_code, r.json()["detail"]) == (409, "downgrade_too_soon")
    assert change(client, "connected", "yearly").status_code == 200


def test_change_kinds() -> None:
    kind = stripe_billing.change_kind
    assert kind(("private", "monthly"), ("private", "yearly")) == "up"
    assert kind(("private", "yearly"), ("private", "monthly")) == "down"
    assert kind(("private", "yearly"), ("connected", "monthly")) == "up"
    assert kind(("connected", "monthly"), ("private", "yearly")) == "down"
    assert kind(("private", "yearly"), ("private", "yearly")) == "same"


def test_a_downgrade_is_immediate_and_leaves_the_rest_as_credit() -> None:
    client, user_id, stripe = subscribed("down", "connected", "yearly", "price_connected_y")
    stripe.due, stripe.total = 0, -7199  # unused Connected less Private for the same time
    r = client.post("/api/billing/change/preview", json={"plan": "private", "interval": "yearly"})
    assert r.status_code == 200, r.text
    preview = r.json()
    assert (preview["kind"], preview["due_now_cents"], preview["credit_after_cents"]) == (
        "down",
        0,
        7199,
    )
    assert preview["disconnects_banks"] is False
    r = change(client, "private", "yearly", proration_date=preview["proration_date"])
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "private"  # at once, no waiting for the renewal
    sent = stripe.form(f"/v1/subscriptions/{row(user_id).external_id}")
    assert sent["items[0][price]"] == "price_private_y"
    assert sent["proration_behavior"] == "always_invoice"
    assert client.get("/api/billing/entitlements").json()["plan"] == "private"
    credit = client.get("/api/billing/credit").json()
    assert credit["credit_cents"] == 7199
    latest = client.get("/api/billing/history").json()[0]
    assert (latest["kind"], latest["plan"], latest["amount_cents"]) == (
        "switched",
        "private",
        -7199,
    )
    assert row(user_id).plan_changed_at is not None


def test_a_downgrade_opens_30_days_after_the_plan_started() -> None:
    client, user_id, _ = subscribed("early", "connected", "monthly", "price_connected_m", days=3)
    opens = client.get("/api/billing").json()["downgrade_from"]
    expected = datetime.now(UTC) + timedelta(days=27)
    assert abs((datetime.fromisoformat(opens) - expected).total_seconds()) < 60
    r = change(client, "private", "monthly")
    assert (r.status_code, r.json()["detail"]) == (409, "downgrade_too_soon")
    started_days_ago(user_id, 31)
    assert client.get("/api/billing").json()["downgrade_from"] is None
    assert change(client, "private", "monthly").status_code == 200


def test_down_to_private_disconnects_linked_banks() -> None:
    fake = FakePlaid()
    plaid.transport_override = fake.transport()
    client, user_id = member("links")
    grant_plan(user_id, "connected", interval="yearly")
    started_days_ago(user_id, 40)
    session_id = start(client, fake, "First Platypus Bank")
    assert client.post("/api/linking/finish", json={"session_id": session_id}).status_code == 200
    stripe = FakeStripe("price_connected_y")
    stripe_billing.transport_override = stripe.transport()
    r = client.post("/api/billing/change/preview", json={"plan": "private", "interval": "yearly"})
    assert r.json()["disconnects_banks"] is True
    assert change(client, "private", "yearly").status_code == 200
    assert fake.removed == fake.access_tokens()  # revoked at Plaid, not just hidden
    assert client.get("/api/linking").json()["connections"] == []


def test_the_billing_month_and_its_end() -> None:
    utc = UTC
    assert stripe_billing.add_months(datetime(2026, 1, 31, tzinfo=utc), 1) == datetime(
        2026, 2, 28, tzinfo=utc
    )
    assert stripe_billing.add_months(datetime(2026, 11, 15, tzinfo=utc), 3) == datetime(
        2027, 2, 15, tzinfo=utc
    )
    start, end = datetime(2026, 7, 9, tzinfo=utc), datetime(2027, 7, 9, tzinfo=utc)
    # October 17 is in the billing month that began October 9: it ends November 9.
    assert stripe_billing.month_end(start, end, datetime(2026, 10, 17, tzinfo=utc)) == datetime(
        2026, 11, 9, tzinfo=utc
    )
    # A monthly period: the month's end is the period's end.
    assert stripe_billing.month_end(
        datetime(2026, 10, 9, tzinfo=utc),
        datetime(2026, 11, 9, tzinfo=utc),
        datetime(2026, 10, 17, tzinfo=utc),
    ) == datetime(2026, 11, 9, tzinfo=utc)


def fee(cents: int) -> int:
    """Stripe's card fee as plans.yaml states it: 2.9% (half up to the cent) + 30¢."""
    return min(cents, (cents * 290 + 5000) // 10000 + 30)


def test_the_refund_fee_is_stripes_card_fee() -> None:
    assert stripe_billing.refund_fee_cents(8773) == 284  # 254.417 → 254, + 30
    assert stripe_billing.refund_fee_cents(5000) == 175  # 145 + 30
    assert stripe_billing.refund_fee_cents(20) == 20  # never more than the refund
    assert stripe_billing.refund_fee_cents(0) == 0


def yearly(stripe: "FakeStripe", days_in: int = 100) -> int:
    """Put the fake on a Connected yearly period `days_in` days in; returns the refund for
    deleting now (owner decision, October 22, 2026): $65 paid less the months used, this one
    included, at the $7 monthly price; never below zero, never more than Stripe's 4000 unused."""
    start = NOW - days_in * 86400
    end = start + 365 * 86400
    stripe.period = (start, end)
    s, e, n = (datetime.fromtimestamp(t, tz=UTC) for t in (start, end, NOW))
    kept = stripe_billing.month_end(s, e, n)
    return max(0, min(4000, 6500 - stripe_billing.months_used(s, kept) * 700))


def test_a_yearly_plan_deleted_early_pays_the_monthly_price_for_months_used() -> None:
    stripe = FakeStripe("price_connected_y")
    assert yearly(stripe) == 6500 - 4 * 700  # 100 days in: the 4th month, $37 back
    assert yearly(stripe, days_in=20) == 4000  # month 1: $58 left, but only what Stripe holds
    assert yearly(stripe, days_in=290) == 0  # month 10: 10 × $7 is more than $65, nothing back
    utc = UTC
    start = datetime(2026, 1, 9, tzinfo=utc)
    assert stripe_billing.months_used(start, datetime(2026, 2, 9, tzinfo=utc)) == 1
    assert stripe_billing.months_used(start, datetime(2026, 5, 9, tzinfo=utc)) == 4


def test_deleting_keeps_this_month_and_refunds_the_rest() -> None:
    client, user_id, stripe = subscribed("leave", "connected", "yearly", "price_connected_y")
    due = yearly(stripe)
    assert due == 3700  # $65 less 4 months at $7
    stripe.balance = -1500  # credit left from an earlier downgrade
    shown = client.get("/api/billing/credit").json()
    owed = 1500 + due
    assert (shown["credit_cents"], shown["refund_if_deleted_cents"]) == (1500, owed - fee(owed))
    assert (shown["refund_fee_bps"], shown["refund_fee_fixed_cents"]) == (290, 30)
    assert shown["refund_before_fee_cents"] == owed
    assert shown["refund_kind"] == "unused"  # the yearly plan's unused months, plus credit
    assert shown["kept_until"] is not None
    r = client.post("/api/account/delete", json={"confirm": "DELETE"})
    assert r.status_code == 204, r.text
    cancel = [f for m, p, f, _ in stripe.calls if m == "DELETE"][-1]
    assert cancel == {}  # ended without Stripe's proration: we refund what's due ourselves
    # The months after this one + the credit, newest charge first; then the credit is cleared.
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_new", owed - fee(owed))]
    assert all(key and key.startswith("closeout:") for _, _, key in stripe.refunds())
    assert stripe.balance == 0
    assert row(user_id).refund_due_cents == 0


def test_a_monthly_plan_keeps_its_month_and_refunds_only_credit() -> None:
    client, user_id, stripe = subscribed("spread", "private", "monthly", "price_private_m")
    stripe.balance = -4000
    stripe.charges = [
        {"id": "ch_a", "created": 1, "amount": 3000, "amount_refunded": 0},
        {"id": "ch_b", "created": 2, "amount": 2000, "amount_refunded": 500},
    ]
    shown = client.get("/api/billing/credit").json()
    assert shown["refund_if_deleted_cents"] == 4000 - 146
    assert shown["refund_kind"] == "credit"  # a monthly plan: only the credit comes back
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_b", 1500), ("ch_a", 2354)]
    assert stripe.balance == 0  # the whole credit is settled, the fee included
    assert "/v1/invoices/create_preview" not in stripe.paths()  # nothing after this month
    from app.services.deletion import cancel_billing

    with get_session_factory()() as db:
        assert cancel_billing(db, uuid.UUID(user_id)) is True  # the purge runs it again
        db.commit()
    assert len(stripe.refunds()) == 2  # nothing left to refund


def test_a_refund_owed_is_kept_until_stripe_takes_it() -> None:
    client, user_id, stripe = subscribed("retry", "connected", "yearly", "price_connected_y")
    due = yearly(stripe)
    stripe.charges = []  # pretend the refund call cannot go through yet
    real = stripe_billing.refund_credit

    def down(*args, **kwargs):
        raise stripe_billing.BillingError("stripe_error")

    stripe_billing.refund_credit = down
    try:
        assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    finally:
        stripe_billing.refund_credit = real
    assert row(user_id).refund_due_cents == due  # remembered, not recomputed later
    stripe.charges = [{"id": "ch_x", "created": 3, "amount": 9588, "amount_refunded": 0}]
    from app.services.deletion import cancel_billing

    with get_session_factory()() as db:
        assert cancel_billing(db, uuid.UUID(user_id)) is True
        db.commit()
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_x", due - fee(due))]
    assert row(user_id).refund_due_cents == 0


def test_founding_keeps_this_month_and_refunds_the_rest_of_its_years() -> None:
    client, user_id = member("founder")
    grant_plan(user_id, "founding")
    with get_session_factory()() as db:
        found = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert found is not None
        found.created_at = datetime.now(UTC) - timedelta(days=365)  # one of four years used
        found.ends_at = found.created_at + timedelta(days=4 * 365)
        db.commit()
    stripe = FakeStripe("price_founding")
    stripe_billing.transport_override = stripe.transport()
    shown = client.get("/api/billing/credit").json()
    preview = shown["refund_if_deleted_cents"]
    assert shown["refund_kind"] == "founding"
    assert 10900 - 350 <= preview <= 11250 - 340  # three years less this month, less the fee
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    [(target, amount, key)] = stripe.refunds()
    assert target == row(user_id).external_id and abs(amount - preview) <= 1
    assert key and key.startswith("founding:")


def test_a_declined_card_changes_nothing() -> None:
    client, user_id, stripe = subscribed("declined", "private", "monthly", "price_private_m")
    stripe.decline = True
    r = change(client, "connected", "yearly")
    assert (r.status_code, r.json()["detail"]) == (402, "payment_failed")
    assert client.get("/api/billing").json()["plan"] == "private"
    assert row(user_id).plan_changed_at is None


def test_change_needs_a_subscription_and_consent() -> None:
    client, _ = member("nosub")
    r = client.post("/api/billing/change/preview", json={"plan": "private", "interval": "monthly"})
    assert (r.status_code, r.json()["detail"]) == (404, "no_subscription")
    assert client.get("/api/billing/credit").json() == {
        "credit_cents": 0,
        "refund_if_deleted_cents": 0,
        "kept_until": None,
        "refund_before_fee_cents": 0,
        "refund_kind": "none",
        "refund_fee_bps": 290,
        "refund_fee_fixed_cents": 30,
        "refund_fee_method": "card",
        "refund_bank_fee_bps": 80,
        "refund_bank_fee_cap_cents": 500,
    }
    client, _, _ = subscribed("noconsent", "private", "monthly", "price_private_m")
    r = client.post("/api/billing/change", json={"plan": "connected", "interval": "monthly"})
    assert (r.status_code, r.json()["detail"]) == (422, "consent_required")


# --- Deleting while Stripe is unreachable (October 25, 2026) ---------------------------------


def _deleted_at(user_id: str) -> datetime:
    from app.models.user import User

    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None and user.deleted_at is not None
        return user.deleted_at


def test_deleting_while_stripe_is_down_ends_the_plan_within_the_hour() -> None:
    from app.services import deletion

    client, user_id, stripe = subscribed("outage", "connected", "yearly", "price_connected_y")
    due = yearly(stripe)
    stripe.down = True
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert "DELETE" not in {m for m, p, _, _ in stripe.calls if p.startswith("/v1/subscriptions/")}
    assert row(user_id).status == "active"  # Stripe could not be told yet
    stripe.down = False
    # The hourly job, not the purge 30 days later
    with get_session_factory()() as db, db.begin():
        assert deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1)) == 1
    assert row(user_id).status == "canceled"
    assert "DELETE" in {m for m, p, _, _ in stripe.calls if p.startswith("/v1/subscriptions/")}
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_new", due - fee(due))]


def test_a_late_retry_still_refunds_as_of_the_day_the_account_was_deleted() -> None:
    """Months after the deletion never count as used, however long Stripe was away."""
    from app.services import deletion

    client, user_id, stripe = subscribed("lateretry", "connected", "yearly", "price_connected_y")
    due = yearly(stripe)  # 100 days in: $37 back
    stripe.down = True
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    stripe.down = False
    with get_session_factory()() as db, db.begin():
        deletion.purge_due(db, grace_days=30, now=datetime.now(UTC) + timedelta(days=31))
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_new", due - fee(due))]


def test_a_renewal_charged_after_the_deletion_is_refunded_in_full() -> None:
    from app.services import deletion

    client, user_id, stripe = subscribed("renewed", "private", "monthly", "price_private_m")
    stripe.down = True
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    after = int(_deleted_at(user_id).timestamp()) + 600
    stripe.charges = [
        {"id": "ch_before", "created": after - 3600, "amount": 300, "amount_refunded": 0},
        {"id": "ch_renewal", "created": after, "amount": 300, "amount_refunded": 0},
    ]
    stripe.down = False
    with get_session_factory()() as db, db.begin():
        deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1))
    refunds = stripe.refunds()
    assert ("ch_renewal", 300) in [(c, a) for c, a, _ in refunds]  # in full: our timing, no fee
    assert "ch_before" not in [c for c, _, _ in refunds]  # the month before deletion is kept


# --- Stripe not answering at all (October 28, 2026) -----------------------------------------
# Invariant: deleting an account never fails and never charges on because Stripe is away; a
# dropped connection is the same outage as a 503 (BillingError), never an unhandled exception.


def test_deleting_while_stripe_cannot_be_reached_still_deletes_and_settles_later() -> None:
    from app.services import deletion

    client, user_id, stripe = subscribed("noroute", "connected", "yearly", "price_connected_y")
    due = yearly(stripe)
    stripe.unreachable = {""}
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert row(user_id).status == "active"  # Stripe could not be told yet
    stripe.unreachable = set()
    with get_session_factory()() as db, db.begin():
        assert deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1)) == 1
    assert row(user_id).status == "canceled"
    assert [(c, a) for c, a, _ in stripe.refunds()] == [("ch_new", due - fee(due))]


def test_one_account_stripe_cannot_reach_never_stops_the_others() -> None:
    from app.models.user import User
    from app.services import deletion

    a_client, a_id, _ = subscribed("noroute_a", "private", "monthly", "price_private_m")
    b_client, b_id, stripe = subscribed("noroute_b", "private", "monthly", "price_private_m")
    stripe.unreachable = {""}
    for c in (a_client, b_client):
        assert c.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    stripe.unreachable = {str(row(a_id).external_id)}  # only A's subscription stays away
    with get_session_factory()() as db, db.begin():
        assert deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1)) == 1
    assert (row(a_id).status, row(b_id).status) == ("active", "canceled")
    later = datetime.now(UTC) + timedelta(days=31)
    with get_session_factory()() as db, db.begin():
        deletion.purge_due(db, grace_days=30, now=later)  # other tests' accounts may go too
    with get_session_factory()() as db:
        assert db.get(User, uuid.UUID(a_id)) is not None  # kept until Stripe answers
        assert db.get(User, uuid.UUID(b_id)) is None
    stripe.unreachable = set()  # Stripe back: A settles too, and leaves nothing for later tests
    with get_session_factory()() as db, db.begin():
        assert deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=2)) == 1
    assert row(a_id).status == "canceled"


def test_a_disputed_plan_deleted_is_settled_once_and_never_again() -> None:
    """Invariant: a deleted account's billing settles once (October 28, 2026). A disputed
    renewing plan refunds nothing (the bank has the money), but a refund worked out before the
    dispute kept refund_due_cents above 0, so the hourly settle picked it up every hour."""
    from app.services import deletion

    client, user_id, stripe = subscribed("disputed", "connected", "yearly", "price_connected_y")
    assert yearly(stripe) > 0
    stripe.unreachable = {"/v1/refunds"}  # the plan ends, the refund has to wait
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert row(user_id).status == "canceled" and (row(user_id).refund_due_cents or 0) > 0
    stripe.unreachable = set()
    with get_session_factory()() as db, db.begin():  # then the payment is disputed
        found = db.scalar(select(Subscription).where(Subscription.user_id == uuid.UUID(user_id)))
        assert found is not None
        found.disputed_at = datetime.now(UTC)
    settled = []
    for hours in (1, 2):
        with get_session_factory()() as db, db.begin():
            later = datetime.now(UTC) + timedelta(hours=hours)
            settled.append(deletion.settle_billing(db, now=later))
    assert settled == [1, 0]
    assert row(user_id).refund_due_cents == 0
    assert stripe.refunds() == []


def test_the_refund_preview_says_stripe_is_away_instead_of_failing() -> None:
    client, _, stripe = subscribed("noroute_c", "private", "monthly", "price_private_m")
    stripe.unreachable = {""}
    r = client.get("/api/billing/credit")
    assert (r.status_code, r.json()["detail"]) == (502, "stripe_unreachable")
