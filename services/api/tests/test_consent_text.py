"""Consent text comes from the server only (October 28, 2026). The app shows the lines the
server builds for an offer and sends them back with the ticked box; checkout, change and cancel
build them again and refuse any other text (409 consent_mismatch), so a modified app cannot keep
words of its own under a valid CONSENT_VERSION. The expected lines below are written out by hand
from the wording the app showed before (apps/web PlanScreen, version 2026-10-24)."""

import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import PurchaseConsent
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import FakeStripe as CheckoutStripe
from tests.test_billing import member
from tests.test_billing_cancel import FakeStripe as CancelStripe
from tests.test_billing_cancel import sub_row
from tests.test_billing_change import FakeStripe as ChangeStripe
from tests.test_billing_change import started_days_ago

VERSION = "2026-10-24"
PAY_WITH = (
    "A credit or debit card issued by a US bank (Visa, Mastercard, Amex, Discover), or a US bank "
    "account. Paid through Stripe; we never see your card or bank details. A bank payment takes "
    "up to 4 business days to clear, and the plan starts when it does."
)
PRIVATE_YEARLY = [
    "$20.00 today, then every year.",
    "Renews automatically each year until you cancel.",
    "Yearly costs less than 12 monthly payments ($36.00) only if you stay the year.",
    "Cancel any time in Me → Plan. It runs to the end of the paid year; nothing is refunded.",
    "Switch up any time for the difference. Switch down from 30 days in; the rest becomes credit.",
    "Delete your account early: the months used, this one included, cost the monthly price "
    "($3.00); the rest of the year comes back, less Stripe's fee.",
    PAY_WITH,
]
AGREE_YEARLY = (
    "I understand my plan renews every year until I cancel, cancelling refunds nothing, and "
    "deleting my account early charges the months used at the monthly price."
)
CONNECTED_MONTHLY = [
    "$7.00 today, then every month.",
    "Renews automatically each month until you cancel.",
    "Cancel any time in Me → Plan. It runs to the month's end.",
    "Switch up any time for the difference. Switch down from 30 days in; the rest becomes credit.",
    "Delete your account: we keep this month; any credit comes back, less Stripe's fee.",
    PAY_WITH,
]
AGREE_MONTHLY = "I understand my plan renews every month until I cancel."
FOUNDING = [
    "$150.00 today, once. No renewal.",
    "4 years of Connected, every feature.",
    "Before it ends, you pick a plan. Nothing is deleted.",
    "Delete your account: we keep this month and refund the rest, less Stripe's fee.",
    PAY_WITH,
]
AGREE_FOUNDING = "I understand this is one payment for the whole term, and it doesn't renew."


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


def consent(lines: list[str], agreement: str, **extra) -> dict:
    return {"version": VERSION, "lines": lines, "agreement": agreement, "accepted": True, **extra}


def kept(user_id: str) -> list[PurchaseConsent]:
    with get_session_factory()() as db:
        rows = db.scalars(
            select(PurchaseConsent).where(PurchaseConsent.user_id == uuid.UUID(user_id))
        ).all()
        for r in rows:
            db.expunge(r)
        return list(rows)


def day(at: datetime, tz: str = "UTC") -> str:
    local = at.astimezone(ZoneInfo(tz))
    return f"{local.strftime('%b')} {local.day}, {local.year}"


def test_checkout_keeps_only_the_servers_words() -> None:
    client, user_id = member("words")
    stripe = CheckoutStripe()
    stripe_billing.transport_override = stripe.transport()
    body = {"plan": "private", "interval": "yearly"}
    forged = [
        consent(["$0.00 today, never renews."], "I agree to nothing."),
        consent(PRIVATE_YEARLY, "I understand my plan renews every month until I cancel."),
        consent(PRIVATE_YEARLY[:-1], AGREE_YEARLY),  # a line left out
        consent([*PRIVATE_YEARLY[:-1], "Paid however you like."], AGREE_YEARLY),
        consent(CONNECTED_MONTHLY, AGREE_MONTHLY),  # another offer's words
    ]
    for c in forged:
        r = client.post("/api/billing/checkout", json={**body, "consent": c})
        assert (r.status_code, r.json()["detail"]) == (409, "consent_mismatch")
    assert stripe.requests == [] and kept(user_id) == []

    offer = client.get("/api/billing/consent/purchase", params=body).json()
    assert offer["version"] == VERSION
    assert offer["lines"] == PRIVATE_YEARLY and offer["agreement"] == AGREE_YEARLY
    assert [p["icon"] for p in offer["points"]] == [
        "price",
        "renew",
        "term",
        "cancel",
        "renew",
        "refund",
        "card",
    ]
    r = client.post(
        "/api/billing/checkout",
        json={**body, "consent": consent(offer["lines"], offer["agreement"])},
    )
    assert r.status_code == 200, r.text
    (row,) = kept(user_id)
    assert row.terms_version == VERSION
    assert row.terms_text == "\n".join([*PRIVATE_YEARLY, f"[x] {AGREE_YEARLY}"])


def test_every_offer_has_its_own_words() -> None:
    client, _ = member("offers")
    get = client.get
    monthly = get("/api/billing/consent/purchase?plan=connected&interval=monthly").json()
    assert (monthly["lines"], monthly["agreement"]) == (CONNECTED_MONTHLY, AGREE_MONTHLY)
    founding = get("/api/billing/consent/purchase?plan=founding").json()
    assert (founding["lines"], founding["agreement"]) == (FOUNDING, AGREE_FOUNDING)
    r = get("/api/billing/consent/purchase?plan=private")
    assert (r.status_code, r.json()["detail"]) == (422, "interval_required")


def test_a_trial_says_when_the_first_charge_is_on_the_devices_calendar() -> None:
    client, user_id = member("trialwords")
    assert client.post("/api/billing/trial", json={"plan": "private"}).status_code == 200
    stripe_billing.transport_override = CheckoutStripe().transport()
    ends = client.get("/api/billing/entitlements").json()["access"]["trial_ends_at"]
    end = datetime.fromisoformat(ends)
    tz = "Pacific/Kiritimati"  # UTC+14: often a day ahead of UTC
    first = f"Free until {day(end, tz)}, then $20.00 every year."
    params = {"plan": "private", "interval": "yearly", "tz": tz}
    offer = client.get("/api/billing/consent/purchase", params=params).json()
    assert offer["lines"] == [first, *PRIVATE_YEARLY[1:]]
    body = {"plan": "private", "interval": "yearly"}
    # The same lines under another zone are not what that zone would read.
    if day(end, tz) != day(end, "UTC"):
        r = client.post(
            "/api/billing/checkout",
            json={**body, "consent": consent(offer["lines"], offer["agreement"])},
        )
        assert r.json()["detail"] == "consent_mismatch"
    r = client.post(
        "/api/billing/checkout",
        json={**body, "consent": consent(offer["lines"], offer["agreement"], tz=tz)},
    )
    assert r.status_code == 200, r.text
    assert kept(user_id)[0].terms_text.startswith(first)


def test_a_switch_keeps_only_the_previews_words() -> None:
    client, user_id = member("switchwords")
    grant_plan(user_id, "private", interval="monthly")
    started_days_ago(user_id, 40)
    stripe = ChangeStripe("price_private_m")
    stripe_billing.transport_override = stripe.transport()
    target = {"plan": "connected", "interval": "monthly"}
    preview = client.post("/api/billing/change/preview", json=target).json()
    lines = [
        "$5.12 today: Connected less what's left of Private.",
        "Connected · monthly starts now. Switching down again opens in 30 days.",
        "Then $7.00 every month until you cancel.",
        "Delete your account: we keep this month; any credit comes back, less Stripe's fee.",
    ]
    assert preview["consent"]["lines"] == lines
    assert preview["consent"]["agreement"] == AGREE_MONTHLY
    assert [p["icon"] for p in preview["consent"]["points"]] == ["price", "term", "renew", "refund"]

    switched = len([p for p in stripe.paths() if p.startswith("/v1/subscriptions/")])
    when = {"proration_date": preview["proration_date"]}
    for c in (
        consent(["Nothing today."], AGREE_MONTHLY),
        consent(["$0.01 today: Connected less what's left of Private.", *lines[1:]], AGREE_MONTHLY),
    ):
        r = client.post("/api/billing/change", json={**target, **when, "consent": c})
        assert (r.status_code, r.json()["detail"]) == (409, "consent_mismatch")
    assert len([p for p in stripe.paths() if p.startswith("/v1/subscriptions/")]) == switched
    assert kept(user_id) == []

    r = client.post(
        "/api/billing/change",
        json={**target, **when, "consent": consent(lines, AGREE_MONTHLY)},
    )
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "connected"
    (row,) = kept(user_id)
    assert (row.kind, row.terms_text) == ("change", "\n".join([*lines, f"[x] {AGREE_MONTHLY}"]))


def test_cancelling_keeps_only_the_servers_words() -> None:
    client, user_id = member("cancelwords")
    grant_plan(user_id, "connected", interval="monthly")
    stripe = CancelStripe()
    stripe_billing.transport_override = stripe.transport()
    renews = sub_row(user_id).renews_at
    assert renews is not None
    lines = [
        f"Stays on: Connected runs until {day(renews.replace(tzinfo=renews.tzinfo or UTC))}.",
        "No charges: Nothing more is billed after that.",
        "7-day grace: Then subscribe again or download your data.",
        "Then deleted: Account and data go; leftover credit is refunded.",
    ]
    agreement = "I have read and understood these terms."
    offer = client.get("/api/billing/consent/cancel").json()
    assert (offer["lines"], offer["agreement"]) == (lines, agreement)
    assert [(p["head"], p["icon"]) for p in offer["points"]][0] == ("Stays on", None)

    for c in (
        consent(["Keep everything: Connected stays on forever."], agreement),
        consent(
            [*lines, "Want money back?: Delete your account instead: $500.00 back."], agreement
        ),
    ):
        r = client.post("/api/billing/cancel", json={"consent": c})
        assert (r.status_code, r.json()["detail"]) == (409, "consent_mismatch")
    assert not any("cancel_at_period_end" in form for _, form in stripe.calls)
    assert kept(user_id) == []

    r = client.post("/api/billing/cancel", json={"consent": consent(lines, agreement)})
    assert r.status_code == 200, r.text
    assert r.json()["cancel_at_period_end"] is True
    (row,) = kept(user_id)
    assert (row.kind, row.terms_text) == ("cancel", "\n".join([*lines, f"[x] {agreement}"]))
    # Nothing renews any more: there is nothing left to cancel or to word.
    other, _ = member("nocancel")
    r = other.get("/api/billing/consent/cancel")
    assert (r.status_code, r.json()["detail"]) == (404, "no_subscription")
