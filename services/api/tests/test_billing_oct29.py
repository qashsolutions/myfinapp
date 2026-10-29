"""Billing defects, October 29, 2026 (invariants 41-43).

41. Never two plans: two payment pages opened at once could both be paid. Every page closes
    after 31 minutes, opening one closes the person's others, and a paid page that would make a
    second live plan is ended at once and refunded in full.
42. A dispute pauses only the plan its charge paid for, and Stripe stops collecting for it
    until the dispute closes: resumed if won, ended if lost.
43. A refund promised on deletion is never marked paid before it is: a bank payment still
    clearing is refunded once it arrives, and the purge waits for it.
"""

import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import CheckoutPage, Subscription
from app.models.user import User
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.conftest import stripe_default_transport
from tests.test_billing import buy, member, post_event

NOW = int(time.time())


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


class Stripe:
    """A stateful sliver of Stripe: pages, subscriptions, invoices and their payments, charges
    and refunds (tagged), enough to follow money through a webhook."""

    PRICES = {
        ("private", "monthly"): "price_private_m",
        ("connected", "yearly"): "price_connected_y",
    }

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, str]]] = []
        self.pages = 0
        self.expire_status = 400  # an older page Stripe has already closed
        self.subs: dict[str, dict] = {}
        self.invoices: dict[str, dict] = {}  # id -> {sub, pi, amount, status}
        self.charges: list[dict] = []
        self.refunds: list[dict] = []
        self.unused = 0  # Stripe's credit for the unused time, were the plan to end now

    # --- building state -------------------------------------------------------------------
    def subscription(
        self, sub_id: str, user_id: str, plan: str, interval: str, *, customer: str = "cus_p"
    ) -> dict:
        start = NOW - 3600
        end = start + (365 if interval == "yearly" else 30) * 86400
        price = self.PRICES[(plan, interval)]
        amount = 6500 if interval == "yearly" else 300
        self.subs[sub_id] = {
            "id": sub_id,
            "object": "subscription",
            "customer": customer,
            "status": "active",
            "created": start,
            "cancel_at_period_end": False,
            "latest_invoice": f"in_{sub_id}",
            "metadata": {"user_id": user_id, "plan": plan, "interval": interval},
            "items": {
                "data": [
                    {
                        "id": f"si_{sub_id}",
                        "price": {"id": price, "unit_amount": amount},
                        "current_period_start": start,
                        "current_period_end": end,
                    }
                ]
            },
        }
        return self.subs[sub_id]

    def paid(
        self, sub_id: str, amount: int, *, method: str = "card", status: str = "succeeded"
    ) -> dict:
        """The subscription's first invoice and its charge (`pending`: a bank debit clearing)."""
        customer = self.subs[sub_id]["customer"] if sub_id in self.subs else "cus_p"
        pi, charge_id = f"pi_{sub_id}", f"ch_{sub_id}"
        self.invoices[f"in_{sub_id}"] = {
            "sub": sub_id,
            "pi": pi,
            "amount": amount,
            "status": "paid" if status == "succeeded" else "open",
        }
        charge = {
            "id": charge_id,
            "customer": customer,
            "payment_intent": pi,
            "amount": amount,
            "amount_refunded": 0,
            "status": status,
            "created": NOW - 3000,
            "method": method,
        }
        self.charges.append(charge)
        return charge

    def clear(self, charge: dict) -> None:
        charge["status"] = "succeeded"
        for inv in self.invoices.values():
            if inv["pi"] == charge["payment_intent"]:
                inv["status"] = "paid"

    # --- reading what happened -------------------------------------------------------------
    def posted(self, path: str) -> list[dict[str, str]]:
        return [f for m, p, f in self.calls if m == "POST" and p == path]

    def deleted(self) -> list[str]:
        return [p.rsplit("/", 1)[-1] for m, p, _ in self.calls if m == "DELETE"]

    def refunded(self) -> list[tuple[str, int, str]]:
        return [
            (r.get("charge") or r.get("payment_intent") or "", r["amount"], r["metadata"]["tag"])
            for r in self.refunds
        ]

    def _charge_json(self, c: dict) -> dict:
        return {
            **{k: v for k, v in c.items() if k != "method"},
            "paid": c["status"] == "succeeded",
            "amount_captured": c["amount"] if c["status"] == "succeeded" else 0,
            "payment_method_details": {"type": c["method"]},
        }

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            path, q = request.url.path, dict(request.url.params)
            form = {
                k: v[0]
                for k, v in parse_qs(request.content.decode(), keep_blank_values=True).items()
            }
            self.calls.append((request.method, path, form))
            ok = httpx2.Response
            if path == "/v1/checkout/sessions" and request.method == "POST":
                self.pages += 1
                expires = int(form.get("expires_at") or NOW + 86400)
                page = f"cs_{self.pages}"
                return ok(
                    200,
                    json={
                        "id": page,
                        "url": f"https://checkout.stripe.com/{page}",
                        "expires_at": expires,
                    },
                )
            if path.startswith("/v1/checkout/sessions/") and path.endswith("/expire"):
                return ok(self.expire_status, json={"id": path.split("/")[4]})
            if path.startswith("/v1/subscriptions/"):
                sub = self.subs.get(path.rsplit("/", 1)[-1])
                if sub is None:
                    return ok(404, json={"error": "no such subscription"})
                if request.method == "DELETE":
                    sub["status"] = "canceled"
                elif request.method == "POST" and "pause_collection[behavior]" in form:
                    sub["pause_collection"] = {"behavior": form["pause_collection[behavior]"]}
                elif request.method == "POST" and "pause_collection" in form:
                    sub["pause_collection"] = None
                return ok(200, json=sub)
            if path == "/v1/invoice_payments":
                rows = [
                    {
                        "invoice": inv_id,
                        "amount_paid": inv["amount"],
                        "status": inv["status"],
                        "payment": {"type": "payment_intent", "payment_intent": inv["pi"]},
                    }
                    for inv_id, inv in self.invoices.items()
                    if q.get("invoice") == inv_id or q.get("payment[payment_intent]") == inv["pi"]
                ]
                return ok(200, json={"data": rows})
            if path.startswith("/v1/invoices/") and request.method == "GET":
                inv_id = path.rsplit("/", 1)[-1]
                inv = self.invoices.get(inv_id)
                if inv is None:
                    return ok(404, json={"error": "no such invoice"})
                parent = {"subscription_details": {"subscription": inv["sub"]}}
                return ok(200, json={"id": inv_id, "status": inv["status"], "parent": parent})
            if path == "/v1/invoices/create_preview":
                return ok(200, json={"total": -self.unused, "amount_due": 0})
            if path.startswith("/v1/charges/"):
                found = [c for c in self.charges if c["id"] == path.rsplit("/", 1)[-1]]
                return ok(200, json=self._charge_json(found[0])) if found else ok(404, json={})
            if path == "/v1/charges":
                data = [
                    self._charge_json(c)
                    for c in self.charges
                    if q.get("customer") in (None, c["customer"])
                    and (q.get("payment_intent") in (None, c["payment_intent"]))
                ]
                return ok(200, json={"data": data})
            if path.startswith("/v1/payment_intents/"):
                pi = path.rsplit("/", 1)[-1]
                found = [c for c in self.charges if c["payment_intent"] == pi]
                latest = self._charge_json(found[0]) if found else {}
                received = found[0]["amount"] if found else 0
                return ok(
                    200,
                    json={
                        "id": pi,
                        "latest_charge": latest,
                        "amount_received": received,
                        "metadata": {},
                    },
                )
            if path == "/v1/refunds" and request.method == "GET":
                data = [
                    {
                        "amount": r["amount"],
                        "status": "succeeded",
                        "metadata": {"qash_refund": r["metadata"]["tag"]},
                    }
                    for r in self.refunds
                    if (q.get("charge") and r.get("charge") == q["charge"])
                    or (q.get("payment_intent") and r.get("payment_intent") == q["payment_intent"])
                ]
                return ok(200, json={"data": data})
            if path == "/v1/refunds":
                refund = {
                    "amount": int(form["amount"]),
                    "metadata": {"tag": form["metadata[qash_refund]"]},
                }
                for key in ("charge", "payment_intent"):
                    if key in form:
                        refund[key] = form[key]
                for c in self.charges:
                    if c["id"] == form.get("charge") or c["payment_intent"] == form.get(
                        "payment_intent"
                    ):
                        c["amount_refunded"] += refund["amount"]
                self.refunds.append(refund)
                return ok(200, json={"id": f"re_{len(self.refunds)}"})
            if path.startswith("/v1/customers/") and path.endswith("/balance_transactions"):
                return ok(200, json={"id": "cbtxn"})
            if path.startswith("/v1/customers/"):
                return ok(200, json={"id": path.rsplit("/", 1)[-1], "balance": 0})
            if path.startswith("/v1/radar/"):
                return ok(200, json={"data": []})
            return ok(404, json={"error": "no fake for this call"})

        return httpx2.MockTransport(handle)


def _event(kind: str, obj: dict) -> dict:
    return {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": kind,
        "created": int(time.time()),
        "data": {"object": obj},
    }


def _checkout(
    sub_id: str, user_id: str, plan: str, interval: str, *, paid: str = "paid", cus: str = "cus_p"
) -> dict:
    return {
        "id": f"cs_{sub_id}",
        "mode": "subscription",
        "payment_status": paid,
        "client_reference_id": user_id,
        "customer": cus,
        "subscription": sub_id,
        "invoice": f"in_{sub_id}",
        "metadata": {"user_id": user_id, "plan": plan, "interval": interval},
    }


def _row(sub_id: str) -> Subscription:
    with get_session_factory()() as db:
        found = db.scalar(select(Subscription).where(Subscription.external_id == sub_id))
        assert found is not None
        db.expunge(found)
        return found


def _state(client) -> dict:
    return client.get("/api/billing/entitlements").json()


def _bought(name: str, stripe: Stripe, plan: str = "private", interval: str = "monthly"):
    """A person with a live plan, bought through a paid checkout (sub_a_<name>)."""
    client, user_id = member(name)
    sub = f"sub_a_{name}"
    stripe.subscription(sub, user_id, plan, interval)
    stripe.paid(sub, 6500 if interval == "yearly" else 300)
    r = post_event(
        client, _event("checkout.session.completed", _checkout(sub, user_id, plan, interval))
    )
    assert r.json()["outcome"] == "subscribed", r.text
    return client, user_id, sub


# --- 41. Never two plans ---------------------------------------------------------------------


def test_every_payment_page_closes_after_31_minutes() -> None:
    client, _ = member("pagelife")
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    r = client.post("/api/billing/checkout", json=buy(client, plan="private", interval="monthly"))
    assert r.status_code == 200, r.text
    [form] = stripe.posted("/v1/checkout/sessions")
    left = int(form["expires_at"]) - datetime.now(UTC).timestamp()
    assert 30 * 60 < left <= 31 * 60 + 2  # Stripe's default would be 24 hours


def test_opening_a_payment_page_closes_the_one_opened_before() -> None:
    client, user_id = member("twotabs")
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    first = client.post(
        "/api/billing/checkout", json=buy(client, plan="private", interval="monthly")
    )
    assert first.status_code == 200
    stripe.expire_status = 200  # still open at Stripe
    second = client.post(
        "/api/billing/checkout", json=buy(client, plan="connected", interval="yearly")
    )
    assert second.status_code == 200
    order = [p for m, p, _ in stripe.calls if m == "POST" and p.startswith("/v1/checkout/sessions")]
    assert order == [
        "/v1/checkout/sessions",
        "/v1/checkout/sessions/cs_1/expire",  # closed before the new one opens
        "/v1/checkout/sessions",
    ]
    # Closed once: a third page closes only the second.
    client.post("/api/billing/checkout", json=buy(client, plan="private", interval="monthly"))
    expired = [p for m, p, _ in stripe.calls if p.endswith("/expire")]
    assert expired == ["/v1/checkout/sessions/cs_1/expire", "/v1/checkout/sessions/cs_2/expire"]
    with get_session_factory()() as db:
        pages = db.scalars(
            select(CheckoutPage).where(CheckoutPage.user_id == uuid.UUID(user_id))
        ).all()
        assert len(pages) == 3


def test_no_new_page_while_an_older_one_cannot_be_closed() -> None:
    client, _ = member("cantclose")
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client.post("/api/billing/checkout", json=buy(client, plan="private", interval="monthly"))
    stripe.expire_status = 503
    r = client.post("/api/billing/checkout", json=buy(client, plan="connected", interval="yearly"))
    assert r.status_code == 502
    assert len(stripe.posted("/v1/checkout/sessions")) == 1  # the second page never opened


def test_a_second_paid_page_is_ended_and_refunded_in_full_and_the_first_plan_stays() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id, first = _bought("second", stripe)
    stripe.subscription("sub_b_second", user_id, "connected", "yearly")
    stripe.paid("sub_b_second", 6500)
    outbox().clear()
    done = _checkout("sub_b_second", user_id, "connected", "yearly")
    r = post_event(client, _event("checkout.session.completed", done))
    assert r.json()["outcome"] == "second_plan"
    assert stripe.deleted() == ["sub_b_second"]
    assert stripe.refunded() == [
        ("pi_sub_b_second", 6500, "second_plan:sub_b_second:pi_sub_b_second")
    ]
    assert _state(client)["plan"] == "private" and _row(first).status == "active"
    refused = _row("sub_b_second")
    assert (refused.status, refused.first_payment) == ("canceled", "refused")
    assert [m.subject for m in outbox()] == ["We refunded a second Qash plan"]
    assert "$" not in outbox()[0].text
    # Delivered again under a new id, and Stripe's own events after it: nothing more.
    post_event(client, _event("checkout.session.completed", done))
    updated = post_event(
        client,
        _event("customer.subscription.updated", stripe.subs["sub_b_second"] | {"status": "active"}),
    )
    assert updated.json()["outcome"] == "stale"
    assert len(stripe.refunds) == 1 and len(outbox()) == 1
    assert _state(client)["plan"] == "private"


def test_a_second_subscription_announced_before_its_checkout_is_refused_too() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id, _ = _bought("secondfirst", stripe)
    sub = stripe.subscription("sub_b_sf", user_id, "connected", "yearly")
    stripe.paid("sub_b_sf", 6500)
    r = post_event(client, _event("customer.subscription.created", sub))
    assert r.json()["outcome"] == "second_plan"
    assert _state(client)["plan"] == "private"  # never Connected, not even for a moment
    r = post_event(
        client,
        _event("checkout.session.completed", _checkout("sub_b_sf", user_id, "connected", "yearly")),
    )
    assert r.json()["outcome"] == "second_plan"
    assert len(stripe.refunds) == 1 and stripe.deleted() == ["sub_b_sf"]
    assert [m.subject for m in outbox()].count("We refunded a second Qash plan") == 1


def test_a_second_plan_paid_by_bank_is_refunded_when_the_payment_clears() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id, _ = _bought("secondach", stripe)
    stripe.subscription("sub_b_ach", user_id, "connected", "yearly")
    charge = stripe.paid("sub_b_ach", 6500, method="us_bank_account", status="pending")
    obj = _checkout("sub_b_ach", user_id, "connected", "yearly", paid="unpaid")
    assert (
        post_event(client, _event("checkout.session.completed", obj)).json()["outcome"]
        == "second_plan"
    )
    assert stripe.deleted() == ["sub_b_ach"] and stripe.refunds == []  # nothing has arrived yet
    stripe.clear(charge)
    cleared = {**obj, "payment_status": "paid"}
    r = post_event(client, _event("checkout.session.async_payment_succeeded", cleared))
    assert r.json()["outcome"] == "second_plan"
    assert stripe.refunded() == [("pi_sub_b_ach", 6500, "second_plan:sub_b_ach:pi_sub_b_ach")]
    assert _state(client)["plan"] == "private"


def test_a_founding_payment_beside_a_renewing_plan_is_refunded_and_takes_no_place() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id, _ = _bought("secondfounding", stripe)
    places = client.get("/api/billing").json()["founding"]
    stripe.charges.append(
        {
            "id": "ch_f",
            "customer": "cus_p",
            "payment_intent": "pi_f2",
            "amount": 15000,
            "amount_refunded": 0,
            "status": "succeeded",
            "created": NOW,
            "method": "card",
        }
    )
    founding = {
        "id": "cs_f2",
        "mode": "payment",
        "payment_status": "paid",
        "client_reference_id": user_id,
        "customer": "cus_p",
        "payment_intent": "pi_f2",
        "metadata": {"user_id": user_id, "plan": "founding"},
    }
    r = post_event(client, _event("checkout.session.completed", founding))
    assert r.json()["outcome"] == "second_plan"
    assert stripe.refunded() == [("pi_f2", 15000, "second_plan:pi_f2")]  # in full, no fee
    assert _state(client)["plan"] == "private"
    assert client.get("/api/billing").json()["founding"] == places


# --- 42. A dispute pauses the plan it paid for, and its collection -----------------------------


def _dispute(kind: str, charge: str, pi: str, status: str = "needs_response") -> dict:
    obj = {
        "id": f"dp_{uuid.uuid4().hex[:6]}",
        "charge": charge,
        "payment_intent": pi,
        "status": status,
    }
    return _event(kind, obj)


def test_a_dispute_pauses_collection_and_winning_it_resumes_it() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("pausewin", stripe)
    r = post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    assert r.json()["outcome"] == "disputed"
    assert stripe.posted(f"/v1/subscriptions/{sub}") == [{"pause_collection[behavior]": "void"}]
    assert _state(client)["access"]["state"] == "paused"
    r = post_event(client, _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "won"))
    assert r.json()["outcome"] == "dispute_won"
    assert stripe.posted(f"/v1/subscriptions/{sub}")[-1] == {"pause_collection": ""}
    assert stripe.subs[sub]["pause_collection"] is None
    assert _state(client)["plan"] == "private"


def test_a_lost_dispute_pauses_first_then_ends_the_plan_at_stripe() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, _, sub = _bought("pauselost", stripe)
    post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    assert _state(client)["access"]["state"] == "paused"
    r = post_event(client, _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "lost"))
    assert r.json()["outcome"] == "dispute_lost"
    assert stripe.deleted() == [sub] and stripe.subs[sub]["status"] == "canceled"
    state = _state(client)
    assert state["plan"] == "free" and state["access"]["state"] == "ended"


def test_a_dispute_on_an_older_plans_charge_leaves_the_live_plan_alone() -> None:
    """The customer's earlier plan (ended) is disputed: only it is marked, the live one runs."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id, old = _bought("olderplan", stripe)
    post_event(
        client, _event("customer.subscription.deleted", stripe.subs[old] | {"status": "canceled"})
    )
    new = "sub_c_olderplan"
    stripe.subscription(new, user_id, "connected", "yearly")
    stripe.paid(new, 6500)
    post_event(
        client, _event("checkout.session.completed", _checkout(new, user_id, "connected", "yearly"))
    )
    assert _state(client)["plan"] == "connected"
    post_event(client, _dispute("charge.dispute.created", f"ch_{old}", f"pi_{old}"))
    assert _row(old).disputed_at is not None
    assert _row(new).disputed_at is None
    assert stripe.posted(f"/v1/subscriptions/{new}") == []  # its collection untouched
    assert _state(client)["plan"] == "connected"


def test_a_dispute_that_lands_before_the_checkout_still_pauses_the_plan_then_ends_it() -> None:
    """Stripe's test card disputes within seconds, before the checkout's own webhook (the
    payments e2e G34, October 29, 2026): the plan must still start paused, and a lost dispute
    must still end it at Stripe."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id = member("racedispute")
    sub = "sub_race"
    stripe.subscription(sub, user_id, "private", "monthly")
    stripe.paid(sub, 300)
    r = post_event(client, _dispute("charge.dispute.created", f"ch_{sub}", f"pi_{sub}"))
    assert r.json()["outcome"] == "disputed"
    assert {"pause_collection[behavior]": "void"} in stripe.posted(f"/v1/subscriptions/{sub}")
    post_event(
        client, _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly"))
    )
    assert _state(client)["access"]["state"] == "paused"
    r = post_event(client, _dispute("charge.dispute.closed", f"ch_{sub}", f"pi_{sub}", "lost"))
    assert r.json()["outcome"] == "dispute_lost"
    assert stripe.subs[sub]["status"] == "canceled"
    assert _state(client)["access"]["state"] == "ended"


# --- 43. A refund promised on deletion is paid, never just recorded ---------------------------


def _deleted(user_id: str) -> User:
    with get_session_factory()() as db:
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None and user.deleted_at is not None
        db.expunge(user)
        return user


def _purged(user_id: uuid.UUID | str, days: int = 31) -> bool:
    """Run the purge, then say whether this test's own account went. Only its own: the purge
    also takes accounts other test files left deleted, so a count would depend on file order."""
    from app.services import deletion

    with get_session_factory()() as db, db.begin():
        deletion.purge_due(db, grace_days=30, now=datetime.now(UTC) + timedelta(days=days))
    with get_session_factory()() as db:
        return db.get(User, uuid.UUID(str(user_id))) is None


def _yearly_by_bank(name: str):
    """A Connected yearly plan ($65) whose first bank debit is still clearing."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    stripe.unused = 6400  # Stripe's credit for the 364 days left
    client, user_id = member(name)
    sub = f"sub_y_{name}"
    stripe.subscription(sub, user_id, "connected", "yearly")
    charge = stripe.paid(sub, 6500, method="us_bank_account", status="pending")
    obj = _checkout(sub, user_id, "connected", "yearly", paid="unpaid")
    assert (
        post_event(client, _event("checkout.session.completed", obj)).json()["outcome"] == "pending"
    )
    return client, user_id, sub, stripe, charge, obj


def test_deleting_while_a_yearly_bank_payment_clears_refunds_all_of_it_once_it_arrives() -> None:
    """Owner decision, October 29, 2026: the plan never started, so the whole $65 comes back,
    no months charged and no bank fee kept; the Delete account screen says so first."""
    client, user_id, sub, stripe, charge, obj = _yearly_by_bank("achdelete")
    due = promised = 6500
    assert client.get("/api/billing/credit").json()["refund_if_deleted_cents"] == promised
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert stripe.deleted() == [sub]
    assert stripe.refunds == []  # nothing can be refunded yet
    assert _row(sub).refund_due_cents == due  # still owed, never marked paid
    # The hourly settle and the purge wait while it clears.
    from app.services import deletion

    with get_session_factory()() as db, db.begin():
        deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=1))
    assert stripe.refunds == [] and _row(sub).refund_due_cents == due
    assert not _purged(user_id)
    # The payment arrives: all of it goes back, once, in full.
    stripe.clear(charge)
    cleared = {**obj, "payment_status": "paid"}
    r = post_event(client, _event("checkout.session.async_payment_succeeded", cleared))
    assert r.json()["outcome"] == "account_deleted"
    assert stripe.refunded() == [(f"pi_{sub}", promised, f"deletion_all:{_row(sub).id}:pi_{sub}")]
    assert _row(sub).refund_due_cents == 0
    post_event(client, _event("checkout.session.async_payment_succeeded", cleared))
    with get_session_factory()() as db, db.begin():
        deletion.settle_billing(db, now=datetime.now(UTC) + timedelta(hours=2))
    assert len(stripe.refunds) == 1
    assert _deleted(user_id).deleted_at is not None
    assert _purged(user_id)


def test_a_bank_payment_that_fails_after_the_deletion_owes_nothing_and_the_purge_goes_on() -> None:
    client, user_id, sub, stripe, charge, obj = _yearly_by_bank("achfail")
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert _row(sub).refund_due_cents == 6500
    charge["status"] = "failed"
    r = post_event(client, _event("checkout.session.async_payment_failed", obj))
    assert r.json()["outcome"] == "payment_failed"
    assert _row(sub).refund_due_cents == 0
    assert stripe.refunds == []
    assert _purged(user_id)


def test_a_page_paid_after_the_deletion_grants_nothing_and_is_refunded_in_full() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id = member("paidafter")
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    deleted_at = _deleted(user_id).deleted_at
    sub = "sub_after"
    stripe.subscription(sub, user_id, "private", "monthly")
    stripe.paid(sub, 300)["created"] = int(deleted_at.timestamp()) + 120
    stripe.subs[sub]["items"]["data"][0]["current_period_start"] = int(deleted_at.timestamp()) + 120
    with get_session_factory()() as db, db.begin():  # the deletion was a while ago
        user = db.get(User, uuid.UUID(user_id))
        assert user is not None
        user.deleted_at = deleted_at - timedelta(minutes=5)
    stripe.charges[-1]["created"] = int(deleted_at.timestamp()) - 60
    r = post_event(
        client, _event("checkout.session.completed", _checkout(sub, user_id, "private", "monthly"))
    )
    assert r.json()["outcome"] == "account_deleted"
    assert stripe.deleted() == [sub]
    assert [(c, a) for c, a, _ in stripe.refunded()] == [(f"ch_{sub}", 300)]
    assert _row(sub).status == "canceled"


def test_a_founding_bank_payment_clearing_at_the_deletion_is_promised_and_refunded_in_full() -> (
    None
):
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    client, user_id = member("foundingach")
    stripe.charges.append(
        {
            "id": "ch_fa",
            "customer": "cus_p",
            "payment_intent": "pi_fa",
            "amount": 15000,
            "amount_refunded": 0,
            "status": "pending",
            "created": NOW,
            "method": "us_bank_account",
        }
    )
    founding = {
        "id": "cs_fa",
        "mode": "payment",
        "payment_status": "unpaid",
        "client_reference_id": user_id,
        "customer": "cus_p",
        "payment_intent": "pi_fa",
        "metadata": {"user_id": user_id, "plan": "founding"},
    }
    assert (
        post_event(client, _event("checkout.session.completed", founding)).json()["outcome"]
        == "pending"
    )
    assert client.get("/api/billing/credit").json()["refund_if_deleted_cents"] == 15000
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    assert stripe.refunds == []
    stripe.charges[-1]["status"] = "succeeded"
    paid = {**founding, "payment_status": "paid"}
    r = post_event(client, _event("checkout.session.async_payment_succeeded", paid))
    assert r.json()["outcome"] == "account_deleted"
    assert [(c, a) for c, a, _ in stripe.refunded()] == [("pi_fa", 15000)]
