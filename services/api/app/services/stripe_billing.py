"""Stripe billing (docs/spec.md "Plans & billing"): hosted Checkout, the Customer Portal and
webhooks, called through `outbound_client` as plain REST so only api.stripe.com is ever
contacted and no SDK brings its own HTTP stack. The server never sees card details.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from calendar import monthrange
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx2
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.billing import BillingEvent, PurchaseBlock, PurchaseConsent, Subscription
from app.models.user import User
from app.rules_server.entitlements import (
    founding_taken,
    is_tester,
    load_plans,
    store_entitlements,
)
from app.security.hashing import pseudonym
from app.security.outbound import outbound_client
from app.services import plan_history
from app.services.email import (
    bank_payment_failed_message,
    dispute_admin_message,
    founding_sold_out_message,
    fraud_admin_message,
    fraud_refund_message,
    get_sender,
    plan_ended_dispute_lost_message,
    plan_link,
    plan_paused_message,
    plan_resumed_message,
)
from app.services.otp import canonical_email

STRIPE_API = "https://api.stripe.com/v1"
SIGNATURE_TOLERANCE_SECONDS = 300
transport_override: httpx2.BaseTransport | None = None


class BillingError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def configured() -> bool:
    """All seven settings present and non-empty; otherwise every plan reads as Free."""
    s = get_settings()
    secrets = [s.stripe_secret_key, s.stripe_webhook_secret]
    prices = [
        s.stripe_price_private_monthly,
        s.stripe_price_private_yearly,
        s.stripe_price_connected_monthly,
        s.stripe_price_connected_yearly,
        s.stripe_price_founding,
    ]
    return all(v is not None and v.get_secret_value().strip() for v in secrets) and all(
        p is not None and p.strip() for p in prices
    )


def open_for(user: User) -> bool:
    """May this person start a purchase? Stripe set up and STACKD_BILLING_OPEN letting them."""
    if not configured():
        return False
    s = get_settings()
    mode = s.billing_open or ("off" if s.env == "prod" else "everyone")
    if mode == "admins":
        return is_tester(user)
    return mode == "everyone"


def price_for(plan: str, interval: str | None) -> str:
    s = get_settings()
    table = {
        ("private", "monthly"): s.stripe_price_private_monthly,
        ("private", "yearly"): s.stripe_price_private_yearly,
        ("connected", "monthly"): s.stripe_price_connected_monthly,
        ("connected", "yearly"): s.stripe_price_connected_yearly,
        ("founding", None): s.stripe_price_founding,
    }
    price = table.get((plan, interval))
    if not price:
        raise BillingError("invalid_plan")
    return price


def plan_for_price(price_id: str) -> tuple[str, str | None] | None:
    s = get_settings()
    for key, value in {
        ("private", "monthly"): s.stripe_price_private_monthly,
        ("private", "yearly"): s.stripe_price_private_yearly,
        ("connected", "monthly"): s.stripe_price_connected_monthly,
        ("connected", "yearly"): s.stripe_price_connected_yearly,
        ("founding", None): s.stripe_price_founding,
    }.items():
        if value == price_id:
            return key
    return None


def _request(
    method: str,
    path: str,
    form: dict[str, str] | None = None,
    *,
    idempotency_key: str | None = None,
) -> httpx2.Response:
    s = get_settings()
    if s.stripe_secret_key is None:
        raise BillingError("billing_unavailable")
    kwargs: dict[str, Any] = {}
    if transport_override is not None:
        kwargs["transport"] = transport_override
    with outbound_client(**kwargs) as client:
        return client.request(
            method,
            f"{STRIPE_API}{path}",
            data=form,
            headers={
                "Authorization": f"Bearer {s.stripe_secret_key.get_secret_value()}",
                **({"Idempotency-Key": idempotency_key} if idempotency_key else {}),
            },
        )


def _post(path: str, form: dict[str, str], *, idempotency_key: str | None = None) -> dict[str, Any]:
    response = _request("POST", path, form, idempotency_key=idempotency_key)
    if response.status_code == 402:
        raise BillingError("payment_failed")  # the card was declined; nothing changed
    if response.status_code >= 400:
        raise BillingError("stripe_error")
    return response.json()


def _get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    if params:
        path = f"{path}?{urlencode(params)}"
    response = _request("GET", path)
    if response.status_code >= 400:
        raise BillingError("stripe_error")
    return response.json()


def cancel_now(subscription_id: str, *, prorate: bool = False) -> None:
    """End a subscription at once (account deletion). With `prorate`, the unused part of the
    paid period goes onto the customer's credit balance, which `refund_credit` then pays back.
    A subscription Stripe no longer has (404) counts as ended."""
    form = {"prorate": "true", "invoice_now": "true"} if prorate else None
    response = _request("DELETE", f"/subscriptions/{subscription_id}", form)
    if response.status_code >= 400 and response.status_code != 404:
        raise BillingError("stripe_error")


# Stripe needs a trial end at least 48 hours ahead; closer than this, billing starts at once.
TRIAL_END_MIN = timedelta(hours=49)


FOUNDING_CHECKOUT_MINUTES = timedelta(minutes=31)  # Stripe refuses under 30 from its clock

CARD_NOTE = (
    "A credit or debit card issued by a US bank (Visa, Mastercard, Amex, Discover), or a US bank "
    "account. A bank payment takes up to 4 business days; your plan starts when it clears."
)


def checkout_session(
    user: User,
    plan: str,
    interval: str | None,
    origin: str,
    customer_id: str | None,
    *,
    trial_ends_at: datetime | None = None,
) -> dict[str, Any]:
    """A hosted Checkout page for the plan; the user is identified by client_reference_id.
    During a free trial the card is saved now and first charged when the trial ends."""
    price = price_for(plan, interval)
    form = {
        "mode": "payment" if plan == "founding" else "subscription",
        # Said above the pay button, since a Radar decline only says "Your card was declined".
        "custom_text[submit][message]": CARD_NOTE,
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        "client_reference_id": str(user.id),
        "success_url": f"{origin}/me/plan?checkout=success",
        "cancel_url": f"{origin}/me/plan?checkout=cancel",
        "metadata[user_id]": str(user.id),
        "metadata[plan]": plan,
    }
    if interval:
        form["metadata[interval]"] = interval
    # US cards (a Radar rule on the card's country, October 17, 2026) or a US bank account
    # (owner decision, October 24, 2026). Stripe picks methods from a payment method
    # configuration rather than payment_method_types; without one, the Dashboard decides.
    if config := get_settings().stripe_payment_method_config:
        form["payment_method_configuration"] = config
    if plan == "founding":
        # A short window (Stripe's minimum), so open pages can't outlast the places left; the
        # webhook checks the count again (October 24, 2026).
        expires = datetime.now(UTC) + FOUNDING_CHECKOUT_MINUTES
        form["expires_at"] = str(int(expires.timestamp()))
        # So a fraud warning that lands before the checkout's own webhook still finds the person.
        form["payment_intent_data[metadata][user_id]"] = str(user.id)
    if plan != "founding":
        form["subscription_data[metadata][user_id]"] = str(user.id)
        form["subscription_data[metadata][plan]"] = plan
        form["subscription_data[metadata][interval]"] = interval or ""
        if trial_ends_at is not None and trial_ends_at - datetime.now(UTC) >= TRIAL_END_MIN:
            form["subscription_data[trial_end]"] = str(int(trial_ends_at.timestamp()))
    if customer_id:
        form["customer"] = customer_id
    else:
        form["customer_email"] = user.email
        if plan == "founding":
            # A one-time payment makes no customer unless asked: without one, a Founding
            # member could never open receipts in the portal (found by the payments e2e).
            form["customer_creation"] = "always"
    return _post("/checkout/sessions", form)


def portal_session(customer_id: str, origin: str) -> dict[str, Any]:
    return _post(
        "/billing_portal/sessions", {"customer": customer_id, "return_url": f"{origin}/me/plan"}
    )


def set_cancel_at_period_end(subscription_id: str, cancel: bool) -> dict[str, Any]:
    """Cancel at the end of the paid period (or undo that). Stripe keeps the subscription
    active until `current_period_end`, then ends it; nothing is refunded or cut short."""
    return _post(
        f"/subscriptions/{subscription_id}",
        {"cancel_at_period_end": "true" if cancel else "false"},
    )


# Changing plans (owner decision, October 17, 2026): every switch happens at once. Up (Private
# → Connected, or monthly → yearly on the same plan) charges the new price less the unused part
# of the old one; down leaves that difference as credit on the customer, which Stripe spends on
# the next bills. Either way the person pays for exactly the days on each plan, at the price
# paid, and money only leaves as a refund when the account is deleted (`refund_credit`).
TIERS = {"private": 1, "connected": 2}


def change_kind(current: tuple[str, str], target: tuple[str, str]) -> str:
    """ "same", "up" (pays the difference now) or "down" (the difference becomes credit)."""
    (cur_plan, cur_interval), (plan, interval) = current, target
    if current == target:
        return "same"
    if TIERS[plan] > TIERS[cur_plan]:
        return "up"
    if TIERS[plan] == TIERS[cur_plan] and cur_interval == "monthly" and interval == "yearly":
        return "up"
    return "down"


def downgrade_opens_at(sub: Subscription) -> datetime | None:
    """When a downgrade is allowed: `downgrade_after_days` after the plan started or last
    changed. None for a row with neither date (nothing to wait for)."""
    days = int(load_plans()["changes"]["downgrade_after_days"])
    # In UTC: the database hands back local times, and 30 days of wall clock across a daylight
    # saving change is an hour off.
    anchors = [d.astimezone(UTC) for d in (sub.created_at, sub.plan_changed_at) if d is not None]
    return max(anchors) + timedelta(days=days) if anchors else None


def get_subscription(subscription_id: str) -> dict[str, Any]:
    return _get(f"/subscriptions/{subscription_id}")


def first_item(subscription: dict[str, Any]) -> dict[str, Any]:
    items = (subscription.get("items") or {}).get("data") or []
    if not items:
        raise BillingError("stripe_error")
    return items[0]


def preview_change(
    subscription: dict[str, Any], price: str, proration_date: int
) -> tuple[int, int]:
    """(charged today, credit on the account afterwards) for switching to `price` now."""
    invoice = _post(
        "/invoices/create_preview",
        {
            "customer": str(subscription.get("customer") or ""),
            "subscription": str(subscription["id"]),
            "subscription_details[items][0][id]": str(first_item(subscription)["id"]),
            "subscription_details[items][0][price]": price,
            "subscription_details[proration_behavior]": "always_invoice",
            "subscription_details[proration_date]": str(proration_date),
        },
    )
    ending = invoice.get("ending_balance")
    if ending is None:
        ending = int(invoice.get("starting_balance") or 0) + int(invoice.get("total") or 0)
    return max(0, int(invoice.get("amount_due") or 0)), max(0, -int(ending))


def switch_price(
    subscription: dict[str, Any],
    plan: str,
    interval: str,
    *,
    proration_date: int | None = None,
) -> dict[str, Any]:
    """Switch the price now and invoice the prorated difference at once: a charge for an
    upgrade, credit for a downgrade. If the card is declined Stripe changes nothing
    (error_if_incomplete) and this raises payment_failed."""
    form = {
        "items[0][id]": str(first_item(subscription)["id"]),
        "items[0][price]": price_for(plan, interval),
        "proration_behavior": "always_invoice",
        "payment_behavior": "error_if_incomplete",
        "cancel_at_period_end": "false",
        "metadata[plan]": plan,
        "metadata[interval]": interval,
        # The switch's invoice, so Plan history can say what was charged or credited.
        "expand[0]": "latest_invoice",
    }
    if proration_date is not None:
        form["proration_date"] = str(proration_date)
    return _post(f"/subscriptions/{subscription['id']}", form)


# Leaving (owner decision, October 17, 2026): when an account is deleted, the current month is
# kept (the plan "runs to the end of the month") and the months after it are refunded to the
# card at the price paid, with any credit left from downgrades. Credit, not cash, only ever
# happens while the account stays open (a downgrade); cash only on deletion.
def customer_credit(customer_id: str) -> int:
    """Credit on the customer's balance in cents (Stripe keeps credit as a negative balance)."""
    return max(0, -int(_get(f"/customers/{customer_id}").get("balance") or 0))


def preview_cancel_credit(subscription_id: str, customer_id: str) -> int:
    """The credit Stripe would give for the unused part of the period if it ended now."""
    invoice = _post(
        "/invoices/create_preview",
        {
            "customer": customer_id,
            "subscription": subscription_id,
            "subscription_details[cancel_now]": "true",
            "subscription_details[proration_behavior]": "create_prorations",
        },
    )
    return max(0, -int(invoice.get("total") or 0))


def add_months(moment: datetime, months: int) -> datetime:
    """Same day of the month `months` later, clamped to the month's last day."""
    total = moment.month - 1 + months
    year, month = moment.year + total // 12, total % 12 + 1
    return moment.replace(year=year, month=month, day=min(moment.day, monthrange(year, month)[1]))


def month_end(start: datetime, end: datetime, now: datetime) -> datetime:
    """The end of the billing month `now` is in: the first monthly anniversary of `start` after
    `now`, never past `end`."""
    months = 1
    while (point := add_months(start, months)) <= now:
        months += 1
    return min(point, end)


def _period_bounds(subscription: dict[str, Any]) -> tuple[datetime | None, datetime | None]:
    item = first_item(subscription)
    start = _epoch(subscription.get("current_period_start") or item.get("current_period_start"))
    return start, period_end(subscription)


def months_used(start: datetime, kept: datetime) -> int:
    """Billing months from `start` up to and including the one that ends at `kept`."""
    months = 1
    while add_months(start, months) < kept:
        months += 1
    return months


def deletion_refund(
    sub: Subscription, now: datetime, *, as_of: datetime | None = None
) -> tuple[int, datetime | None]:
    """(cents to refund, end of the month we keep) for ending this plan on deletion. A yearly
    plan (owner decision, October 22, 2026): the months used, this one included, cost the monthly
    price; the rest of what was paid for the year comes back, never below zero and never more
    than Stripe's credit for the unused time. A monthly plan: nothing after this month. A plan
    behind on payment: nothing. Founding: the share of the payment after the month's end. A plan
    with a disputed payment (October 24, 2026): nothing, since the bank has already returned the
    money, and a refund on top would pay it twice.

    `as_of` is when the account was deleted, when that was earlier than `now` (Stripe was
    unreachable then, October 25, 2026): the months after it never count as used, and Stripe's
    credit for the unused time is taken back to that day."""
    if sub.disputed_at is not None:
        return 0, None
    when = as_of or now
    if sub.interval is None:
        start, end = sub.created_at, sub.ends_at
        if start is None or end is None or end <= when:
            return 0, None
        start, end = start.astimezone(UTC), end.astimezone(UTC)
        kept = month_end(start, end, when)
        paid = int(load_plans()["founding"]["one_time_cents"])
        span = int((end - start).total_seconds())
        return paid * int((end - kept).total_seconds()) // span, kept
    if sub.status != "active" or not sub.external_id or not sub.customer_id:
        return 0, None
    live = get_subscription(sub.external_id)
    start, end = _period_bounds(live)
    if start is None or end is None or end <= when:
        return 0, None
    if start > when:
        return 0, None  # it renewed after the deletion: that charge is refunded in full instead
    kept = month_end(start, end, when)
    if kept >= end:
        return 0, kept  # a monthly plan, or the last month of a year: nothing after it
    unused = preview_cancel_credit(sub.external_id, sub.customer_id)
    if when < now < end:  # Stripe's credit is for the time left now; take it back to `when`
        unused = unused * int((end - when).total_seconds()) // int((end - now).total_seconds())
    prices = load_plans()["plans"][sub.plan]["price_cents"]
    paid = int((first_item(live).get("price") or {}).get("unit_amount") or prices["yearly"])
    used = months_used(start, kept) * int(prices["monthly"])
    return max(0, min(unused, paid - used)), kept


def refund_fee_cents(cents: int, method: str = "card") -> int:
    """Stripe's fee taken off a refund of `cents` (plans.yaml `refunds`), never more than the
    refund itself: the card fee, or the bank fee (0.8%, capped) for a US bank payment."""
    if cents <= 0:
        return 0
    rule = load_plans()["refunds"]
    if method == "bank":
        fee = min(
            (cents * int(rule["bank_fee_bps"]) + 5000) // 10000, int(rule["bank_fee_cap_cents"])
        )
    else:
        fee = (cents * int(rule["fee_bps"]) + 5000) // 10000 + int(rule["fee_fixed_cents"])
    return min(cents, fee)


def _method_of(charge: dict[str, Any] | None) -> str:
    kind = ((charge or {}).get("payment_method_details") or {}).get("type")
    return "bank" if kind == "us_bank_account" else "card"


def payment_method_of_intent(payment_intent: str) -> str:
    """ "card" or "bank" for one payment, from its charge."""
    intent = _get(f"/payment_intents/{payment_intent}", {"expand[]": "latest_charge"})
    charge = intent.get("latest_charge")
    return _method_of(charge if isinstance(charge, dict) else None)


def _newest_paid(charges: list[dict[str, Any]]) -> dict[str, Any] | None:
    paid = [c for c in charges if c.get("paid") and c.get("status") == "succeeded"]
    return max(paid, key=lambda c: int(c.get("created") or 0)) if paid else None


def payment_method_of_customer(customer_id: str) -> str:
    """ "card" or "bank": how the customer's newest payment was made."""
    charges = _get("/charges", {"customer": customer_id, "limit": "100"}).get("data") or []
    return _method_of(_newest_paid(charges))


# Every refund we make carries this metadata tag (October 24, 2026). Before refunding we look
# for it at Stripe, so a retry, even days later when Stripe has forgotten an idempotency key
# or after a timeout where the refund did go through, never pays the same thing twice.
REFUND_TAG = "qash_refund"


def _tagged_refunds(params: dict[str, str]) -> list[dict[str, Any]]:
    """Our refunds (by tag) on one charge or payment intent, failed and canceled ones left out."""
    data = _get("/refunds", {**params, "limit": "100"}).get("data") or []
    return [
        r
        for r in data
        if (r.get("metadata") or {}).get(REFUND_TAG)
        and str(r.get("status") or "succeeded") not in ("failed", "canceled")
    ]


def _refund(
    target: dict[str, str], cents: int, tag: str, reason: str = "requested_by_customer"
) -> None:
    _post(
        "/refunds",
        {
            **target,
            "amount": str(cents),
            "reason": reason,
            f"metadata[{REFUND_TAG}]": tag,
        },
        idempotency_key=f"{tag}:{cents}",
    )


def refund_payment(payment_intent: str, cents: int, *, key: str, fee: bool = True) -> None:
    """Refund `cents` of one payment, less Stripe's card fee unless `fee` is False, at most once
    for `key`."""
    if fee:
        cents -= refund_fee_cents(cents, payment_method_of_intent(payment_intent))
    if cents <= 0:
        return
    done = _tagged_refunds({"payment_intent": payment_intent})
    if any((r.get("metadata") or {}).get(REFUND_TAG) == key for r in done):
        return
    _refund({"payment_intent": payment_intent}, cents, key)


def refund_charges_since(customer_id: str, since: datetime, *, key: str) -> int:
    """Charges Stripe made after `since` (a renewal while it couldn't be told the account was
    deleted, October 25, 2026): each refunded in full, no fee (our timing), at most once for
    `key`; a disputed charge's money is already with the bank. Returns cents refunded."""
    after = int(since.timestamp())
    charges = (
        _get("/charges", {"customer": customer_id, "limit": "100", "created[gt]": str(after)}).get(
            "data"
        )
        or []
    )
    total = 0
    for charge in charges:
        if int(charge.get("created") or 0) <= after or charge.get("disputed"):
            continue
        if not charge.get("paid") or charge.get("status") != "succeeded":
            continue
        room = int(charge.get("amount_captured") or charge.get("amount") or 0) - int(
            charge.get("amount_refunded") or 0
        )
        tag = f"{key}:{charge['id']}"
        done = _tagged_refunds({"charge": str(charge["id"])})
        if room <= 0 or any((r.get("metadata") or {}).get(REFUND_TAG) == tag for r in done):
            continue
        _refund({"charge": str(charge["id"])}, room, tag)
        total += room
    return total


def refund_credit(customer_id: str, *, key: str, extra_cents: int = 0) -> int:
    """Pay the customer's credit, plus `extra_cents` owed for unused months, less Stripe's
    fee for how they paid (card or bank), back to the cards or bank accounts they paid with,
    newest charge first, then clear the credit so nothing is refunded twice. Each charge gets
    at most one refund tagged `key:<charge>`, and what earlier tries already refunded under
    `key` is counted first, so a retry after a partial failure or a timeout only pays what is
    still owed. Returns cents refunded in all."""
    credit = customer_credit(customer_id)
    owed = credit + max(0, extra_cents)
    if owed <= 0:
        return 0  # nothing due and no credit to settle
    charges = _get("/charges", {"customer": customer_id, "limit": "100"}).get("data") or []
    owed -= refund_fee_cents(owed, _method_of(_newest_paid(charges)))
    if owed <= 0:
        if credit:  # all of it went to the fee: the credit is settled all the same
            _post(
                f"/customers/{customer_id}/balance_transactions",
                {"amount": str(credit), "currency": "usd", "description": "Settled on deletion"},
                idempotency_key=f"{key}:balance:{credit}",
            )
        return 0
    already = 0
    done: set[str] = set()
    for charge in charges:
        mine = [
            r
            for r in _tagged_refunds({"charge": str(charge["id"])})
            if str((r.get("metadata") or {}).get(REFUND_TAG, "")).startswith(f"{key}:")
        ]
        if mine:
            done.add(str(charge["id"]))
            already += sum(int(r.get("amount") or 0) for r in mine)
    refunded = already
    for charge in sorted(charges, key=lambda c: int(c.get("created") or 0), reverse=True):
        if refunded >= owed:
            break
        if str(charge["id"]) in done or not charge.get("paid") or charge.get("disputed"):
            continue  # a disputed charge's money is already with the bank, never refunded twice
        if charge.get("status") != "succeeded":
            continue
        room = int(charge.get("amount_captured") or charge.get("amount") or 0) - int(
            charge.get("amount_refunded") or 0
        )
        amount = min(owed - refunded, room)
        if amount <= 0:
            continue
        _refund({"charge": str(charge["id"])}, amount, f"{key}:{charge['id']}")
        refunded += amount
    if credit:
        # All of it went to the fee, or it's been paid back: either way the credit is settled.
        cleared = credit if refunded >= owed else min(credit, refunded)
        if cleared:
            _post(
                f"/customers/{customer_id}/balance_transactions",
                {
                    "amount": str(cleared),
                    "currency": "usd",
                    "description": "Refunded on account deletion",
                },
                idempotency_key=f"{key}:balance:{cleared}",
            )
    return refunded


def verify_signature(
    payload: bytes, header: str, secret: str, *, now: float | None = None
) -> dict[str, Any]:
    """Stripe's scheme: HMAC-SHA256 over "{t}.{payload}"; a five-minute tolerance on t."""
    now = now or time.time()
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature or not timestamp.isdigit():
        raise BillingError("bad_signature")
    if abs(now - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        raise BillingError("bad_signature")
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise BillingError("bad_signature")
    try:
        return json.loads(payload)
    except ValueError as exc:
        raise BillingError("bad_payload") from exc


def sign(payload: bytes, secret: str, *, timestamp: int) -> str:
    """Build a Stripe-Signature header (tests, and the mirror of verify_signature)."""
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={mac}"


def _epoch(value: Any) -> datetime | None:
    return datetime.fromtimestamp(int(value), tz=UTC) if value else None


def _status(stripe_status: str) -> str:
    if stripe_status in ("active", "trialing"):
        return "active"
    if stripe_status == "past_due":
        return "past_due"
    if stripe_status in ("incomplete",):
        return "incomplete"
    return "canceled"


def period_end(obj: dict[str, Any]) -> datetime | None:
    if obj.get("current_period_end"):
        return _epoch(obj["current_period_end"])
    items = (obj.get("items") or {}).get("data") or []
    if items and items[0].get("current_period_end"):
        return _epoch(items[0]["current_period_end"])
    return None


# Checkout's payment_status values that mean the money is in (or a trial needs none yet).
PAID = {"paid", "no_payment_required"}


def apply_event(db: DbSession, event: dict[str, Any], *, now: datetime | None = None) -> str:
    """Applies one webhook event once. Returns what happened (for logs and tests).

    Stripe delivers late and out of order (retries run for days), so (October 24, 2026): a
    subscription event older than the newest one applied to that row is skipped, a
    subscription Stripe has canceled is never reopened, and a checkout completion that lands
    after the subscription's own events only fills in what is missing."""
    now = now or datetime.now(UTC)
    event_id = str(event.get("id") or "")
    kind = str(event.get("type") or "")
    if not event_id:
        raise BillingError("bad_payload")
    if db.scalar(select(BillingEvent.id).where(BillingEvent.event_id == event_id)) is not None:
        return "duplicate"
    created = _epoch(event.get("created")) or now
    obj = (event.get("data") or {}).get("object") or {}
    outcome = "ignored"
    if kind in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        # A delayed payment method completes the session unpaid, then pays later: the plan
        # starts when the money is in, never before and never not at all.
        outcome = _checkout_completed(db, obj, created=created, now=now)
    elif kind == "checkout.session.async_payment_failed":
        outcome = _bank_payment_failed(db, obj)
    elif kind in ("charge.dispute.created", "charge.dispute.closed"):
        outcome = _dispute(db, kind, obj, now=now)
    elif kind == "radar.early_fraud_warning.created":
        outcome = _fraud_warning(db, obj, now=now)
    elif kind in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        outcome = _subscription_event(db, kind, obj, created=created, now=now)
    db.add(BillingEvent(event_id=event_id, kind=kind))
    db.flush()
    return outcome


def _checkout_completed(
    db: DbSession, obj: dict[str, Any], *, created: datetime, now: datetime
) -> str:
    user_id = _user_id(obj.get("client_reference_id") or (obj.get("metadata") or {}).get("user_id"))
    plan = (obj.get("metadata") or {}).get("plan")
    interval = (obj.get("metadata") or {}).get("interval") or None
    if not user_id or plan not in ("private", "connected", "founding"):
        return "ignored"
    _lock_person(db, user_id)
    if refused := _refuse_blocked(db, user_id, obj):
        return refused
    paid = str(obj.get("payment_status") or "") in PAID
    customer = obj.get("customer")
    if obj.get("mode") == "payment" and plan == "founding":
        external_id = str(obj.get("payment_intent") or obj.get("id"))
        held = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
        if held is not None and held.status == "active":
            return "founding"  # already granted (a redelivery under a new event id)
        # Every grant passes the cap: a new purchase, and one whose place was given back (a
        # failed bank payment, `expired`). Only a place still held (`incomplete`) skips it.
        holds_place = held is not None and held.status != "expired"
        if held is not None and held.status == "expired" and not paid:
            return "payment_failed"  # this bank payment already failed: hold nothing
        if not holds_place and founding_over_cap(db, exclude=external_id):
            if not paid:
                return "founding_sold_out"  # nothing has been taken yet; Stripe won't collect
            return _refund_oversold(db, user_id, external_id, customer)
        if not paid:
            # A US bank payment clears in up to 4 business days (October 24, 2026): the place
            # is held now (`incomplete` counts toward the cap) and the plan starts when the
            # money is in (checkout.session.async_payment_succeeded).
            _upsert(
                db,
                external_id=external_id,
                user_id=user_id,
                plan="founding",
                status="incomplete",
                interval=None,
                customer_id=customer,
                renews_at=None,
                ends_at=None,
                cancel_at_period_end=False,
            )
            return "pending"
        years = int(load_plans()["founding"]["term_years"])
        _upsert(
            db,
            external_id=external_id,
            user_id=user_id,
            plan="founding",
            status="active",
            interval=None,
            customer_id=customer,
            renews_at=None,
            ends_at=now + timedelta(days=365 * years + years // 4),
            cancel_at_period_end=False,
        )
        plan_history.add(
            db,
            user_id,
            "subscribed",
            "founding",
            amount_cents=int(load_plans()["founding"]["one_time_cents"]),
            at=now,
        )
        store_entitlements(db, user_id)
        return "founding"
    if obj.get("mode") != "subscription" or not obj.get("subscription"):
        return "ignored"
    external_id = str(obj["subscription"])
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    if not paid:
        # A US bank payment still clearing (October 24, 2026). Stripe calls the subscription
        # active meanwhile, so the plan waits on first_payment until async_payment_succeeded.
        if row is None:
            row = _upsert(
                db,
                external_id=external_id,
                user_id=user_id,
                plan=plan,
                status="active",
                interval=interval,
                customer_id=customer,
                renews_at=None,
                ends_at=None,
                cancel_at_period_end=False,
            )
            row.last_event_at = created
        if row.first_payment == "failed":
            return "payment_failed"  # its failure arrived first: nothing to wait for
        if row.first_payment is None:
            row.first_payment = "pending"
        row.customer_id = row.customer_id or customer
        db.flush()
        store_entitlements(db, user_id)
        return "pending"
    if row is not None and row.first_payment == "pending":
        row.first_payment = "paid"  # the bank payment cleared
    if row is None:
        row = _upsert(
            db,
            external_id=external_id,
            user_id=user_id,
            plan=plan,
            status="active",
            interval=interval,
            customer_id=customer,
            renews_at=None,
            ends_at=None,
            cancel_at_period_end=False,
        )
        row.last_event_at = created
    else:
        # The subscription's own events got here first and know more: keep their status,
        # dates and cancel flag, and only fill in the customer.
        row.customer_id = row.customer_id or customer
        db.flush()
    prices = load_plans()["plans"][plan]["price_cents"]
    plan_history.add(
        db,
        user_id,
        "subscribed",
        plan,
        interval,
        amount_cents=int(prices[interval]) if interval in prices else None,
        at=now,
    )
    store_entitlements(db, user_id)
    return "subscribed"


def _bank_payment_failed(db: DbSession, obj: dict[str, Any]) -> str:
    """A delayed (bank) payment that did not go through: no plan, a Founding place given back,
    and the person told in plain words."""
    user_id = _user_id(obj.get("client_reference_id") or (obj.get("metadata") or {}).get("user_id"))
    if not user_id:
        return "ignored"
    _lock_person(db, user_id)
    # Stripe may deliver this before the checkout's completion (whose delivery kept failing) or
    # the subscription's creation: act on it anyway, and leave a row saying it failed, so a late
    # completion can't hold a Founding place or wait for money that will never come
    # (October 25, 2026).
    plan = (obj.get("metadata") or {}).get("plan")
    customer = obj.get("customer")
    if obj.get("mode") == "payment":
        external_id = str(obj.get("payment_intent") or obj.get("id"))
        row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
        if row is None and plan == "founding":
            row = _upsert(
                db,
                external_id=external_id,
                user_id=user_id,
                plan="founding",
                status="expired",
                interval=None,
                customer_id=customer,
                renews_at=None,
                ends_at=None,
                cancel_at_period_end=False,
            )
        elif row is not None and row.status == "incomplete":
            row.status = "expired"  # never paid: the Founding place goes back
        db.flush()
    elif obj.get("subscription"):
        # Stripe would keep the subscription past due and retry the debit; the plan never
        # started, so it ends here and nothing is ever taken for it.
        external_id = str(obj["subscription"])
        row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
        if row is None or row.first_payment != "paid":
            cancel_now(external_id)
        if row is None and plan in ("private", "connected"):
            row = _upsert(
                db,
                external_id=external_id,
                user_id=user_id,
                plan=plan,
                status="canceled",
                interval=(obj.get("metadata") or {}).get("interval") or None,
                customer_id=customer,
                renews_at=None,
                ends_at=datetime.now(UTC),
                cancel_at_period_end=False,
            )
        if row is not None and row.first_payment != "paid":
            row.first_payment = "failed"
            row.status, row.stripe_status = "canceled", "canceled"
            row.ends_at = row.ends_at or datetime.now(UTC)
        db.flush()
    user = db.get(User, user_id)
    if user is not None and user.deleted_at is None:
        get_sender().send(bank_payment_failed_message(user.email, plan_link()))
    store_entitlements(db, user_id)
    return "payment_failed"


def _rows_for_charge(db: DbSession, obj: dict[str, Any]) -> list[Subscription]:
    """The plans a disputed charge paid for: Founding by its payment intent, a subscription by
    the charge's customer (Stripe's dispute names the charge, not the subscription)."""
    intent = str(obj.get("payment_intent") or "")
    rows = list(db.scalars(select(Subscription).where(Subscription.external_id == intent)))
    if rows or not obj.get("charge"):
        return rows
    charge = _get(f"/charges/{obj['charge']}")
    customer = charge.get("customer")
    if not customer:
        return []
    return list(
        db.scalars(
            select(Subscription).where(
                Subscription.customer_id == str(customer), Subscription.source == "stripe"
            )
        )
    )


def _charge_customer(obj: dict[str, Any]) -> str | None:
    if not obj.get("charge"):
        return None
    customer = _get(f"/charges/{obj['charge']}").get("customer")
    return str(customer) if customer else None


def _dispute(db: DbSession, kind: str, obj: dict[str, Any], *, now: datetime) -> str:
    """Disputes (owner decision, October 24, 2026): a dispute pauses the plan it paid for and
    tells the person (and the admins); won or withdrawn, the plan comes back; lost, every plan
    it paid for ends today, a subscription at Stripe so nothing is charged again, and the
    account is `ended`: open, never closed for it (owner, October 25, 2026). Nothing is ever
    deleted because of a dispute."""
    rows = _rows_for_charge(db, obj)
    if not rows:
        if kind == "charge.dispute.closed" and str(obj.get("status") or "") == "lost":
            # The account is gone (purged): no plan to end, but the inbox it bought with and
            # the card still can't buy again (October 27, 2026).
            customer = _charge_customer(obj)
            if customer and _inbox_keys(db, None, customer):
                block_purchases(db, None, "dispute_lost", customer=customer)
                block_payer(str(obj.get("charge") or ""))
                return "dispute_lost_after_deletion"
        if kind == "charge.dispute.created":
            # Stripe still wants evidence before its deadline (October 27, 2026).
            _tell_admins_of_dispute(obj, matched=False)
            return "disputed_unmatched"
        return "ignored"
    users = {r.user_id for r in rows}
    for user_id in sorted(users):
        _lock_person(db, user_id)
    for r in rows:
        db.refresh(r)  # read again now that nothing else is changing them
    if kind == "charge.dispute.created":
        for r in rows:
            r.disputed_at = r.disputed_at or now
        outcome, message = "disputed", plan_paused_message
    else:
        status = str(obj.get("status") or "")
        if status in ("won", "warning_closed"):
            for r in rows:
                r.disputed_at = None
            outcome, message = "dispute_won", plan_resumed_message
        else:  # lost: the money went back to the person; every plan it paid for ends today
            # (a renewing one at Stripe, Founding here). The account is `ended`, not paused
            # (which says the plan comes back by itself), and stays open (October 25, 2026).
            _end_now(db, rows, now)
            for r in rows:
                r.dispute_lost_at = r.dispute_lost_at or now
            # They kept the money: the inbox and the card (or bank account) can't buy again.
            customers = {r.customer_id for r in rows if r.customer_id}
            for user_id in users:
                block_purchases(db, user_id, "dispute_lost")
            for customer in sorted(customers):
                block_purchases(db, None, "dispute_lost", customer=customer)
            block_payer(str(obj.get("charge") or ""))
            outcome, message = "dispute_lost", plan_ended_dispute_lost_message
    db.flush()
    for user_id in users:
        store_entitlements(db, user_id)
        user = db.get(User, user_id)
        if user is not None and user.deleted_at is None and message is not None:
            get_sender().send(message(user.email, plan_link()))
    if kind == "charge.dispute.created":
        _tell_admins_of_dispute(obj, matched=True)
    return outcome


def _tell_admins_of_dispute(obj: dict[str, Any], *, matched: bool) -> None:
    for admin in get_settings().admin_emails:
        if admin.strip():
            get_sender().send(
                dispute_admin_message(admin.strip(), str(obj.get("id") or ""), matched=matched)
            )


def _end_now(db: DbSession, rows: list[Subscription], now: datetime) -> None:
    """End these plans today: a subscription at Stripe (so nothing renews), Founding here."""
    for r in rows:
        if r.status not in ("active", "past_due", "incomplete"):
            continue
        if r.interval and r.external_id:
            cancel_now(r.external_id)
        r.status, r.stripe_status, r.ends_at = "canceled", "canceled", now
        r.cancel_at_period_end = False


def _fraud_warning(db: DbSession, obj: dict[str, Any], *, now: datetime) -> str:
    """An early fraud warning (owner decision, October 24, 2026): the card's bank says a payment
    may not have been made by the cardholder, which usually turns into a dispute. Refunding it
    in full first costs less than the dispute (no dispute fee, nothing on the dispute rate) and
    is right for the cardholder: the payment is refunded, the plans it paid for end today, and
    the inbox and card can't buy again. Stripe marks a warning not actionable once the payment
    is already refunded or disputed; then the dispute's own handling applies."""
    if not obj.get("actionable"):
        return "ignored"
    charge_id = str(obj.get("charge") or "")
    if not charge_id:
        return "ignored"
    charge = _get(f"/charges/{charge_id}")
    rows = _rows_for_charge(db, obj)
    # The warning can arrive before the checkout's own webhooks (seen in test mode): then the
    # plan isn't here yet, so the person and their subscriptions are found at Stripe, the
    # subscriptions are ended there (their deletion webhook follows), and the block below
    # keeps the late checkout completion from granting anything.
    owners, live = _stripe_owners(obj, charge)
    users = {r.user_id for r in rows} | {u for u in owners if db.get(User, u) is not None}
    for user_id in sorted(users):
        _lock_person(db, user_id)
    for r in rows:
        db.refresh(r)
    tag = f"fraud_warning:{charge_id}"
    left = int(charge.get("amount_captured") or charge.get("amount") or 0) - int(
        charge.get("amount_refunded") or 0
    )
    done = _tagged_refunds({"charge": charge_id})
    if left > 0 and not any((r.get("metadata") or {}).get(REFUND_TAG) == tag for r in done):
        # In full and fee-free to the cardholder; "fraudulent" also tells Stripe's Radar.
        _refund({"charge": charge_id}, left, tag, reason="fraudulent")
    ended = {r.external_id for r in rows}
    for sub_id in live - ended:
        cancel_now(sub_id)
    _end_now(db, rows, now)
    for user_id in users:
        block_purchases(db, user_id, "fraud_warning")
    if customer := charge.get("customer"):
        block_purchases(db, None, "fraud_warning", customer=str(customer))
    block_payer(charge_id, charge)
    db.flush()
    for user_id in users:
        store_entitlements(db, user_id)
        user = db.get(User, user_id)
        if user is not None and user.deleted_at is None:
            get_sender().send(fraud_refund_message(user.email, plan_link()))
    for admin in get_settings().admin_emails:
        if admin.strip():
            get_sender().send(fraud_admin_message(admin.strip(), str(obj.get("id") or "")))
    return "fraud_refunded" if users else "fraud_refunded_unknown"


def _stripe_owners(obj: dict[str, Any], charge: dict[str, Any]) -> tuple[set[uuid.UUID], set[str]]:
    """Who a charge belongs to as Stripe knows it, and their live subscriptions there: the
    payment's own metadata (Founding) and the customer's subscriptions (metadata user_id)."""
    owners: set[uuid.UUID] = set()
    live: set[str] = set()
    if obj.get("payment_intent"):
        intent = _get(f"/payment_intents/{obj['payment_intent']}")
        if owner := _user_id((intent.get("metadata") or {}).get("user_id")):
            owners.add(owner)
    if customer := charge.get("customer"):
        subs = _get("/subscriptions", {"customer": str(customer), "status": "all"})
        for sub in subs.get("data") or []:
            if owner := _user_id((sub.get("metadata") or {}).get("user_id")):
                owners.add(owner)
            if sub.get("status") in ("active", "trialing", "past_due", "incomplete", "unpaid"):
                live.add(str(sub["id"]))
    return owners, live


def _refuse_blocked(db: DbSession, user_id: uuid.UUID, obj: dict[str, Any]) -> str | None:
    """A checkout that completes for an inbox that may not buy (a fraud warning that came
    first, or a page opened before a lost dispute): nothing is granted, a subscription is ended
    at Stripe, and whatever it took that isn't refunded yet is refunded in full."""
    user = db.get(User, user_id)
    if user is None or not is_blocked(db, user):
        return None
    params: dict[str, str] | None = None
    if obj.get("mode") == "subscription" and obj.get("subscription"):
        cancel_now(str(obj["subscription"]))
        if obj.get("customer"):
            params = {"customer": str(obj["customer"])}
    elif obj.get("payment_intent"):
        params = {"payment_intent": str(obj["payment_intent"])}
    if params and str(obj.get("payment_status") or "") == "paid":
        since = int(obj.get("created") or 0)
        for c in _get("/charges", {**params, "limit": "10"}).get("data") or []:
            if int(c.get("created") or 0) < since or c.get("status") != "succeeded":
                continue  # only what this checkout took
            left = int(c.get("amount_captured") or c.get("amount") or 0) - int(
                c.get("amount_refunded") or 0
            )
            tag = f"blocked:{c['id']}"
            mine = _tagged_refunds({"charge": str(c["id"])})
            if left > 0 and not any((r.get("metadata") or {}).get(REFUND_TAG) == tag for r in mine):
                _refund({"charge": str(c["id"])}, left, tag)
    return "blocked"


def purchase_block_key(email: str) -> str:
    return pseudonym(canonical_email(email))


def inbox_blocked(db: DbSession, email: str) -> bool:
    """True when this inbox may not buy again (`PurchaseBlock`)."""
    key = purchase_block_key(email)
    return db.scalar(select(PurchaseBlock.id).where(PurchaseBlock.email_hash == key)) is not None


def _inbox_keys(db: DbSession, user_id: uuid.UUID | None, customer: str | None = None) -> set[str]:
    """Every inbox a person bought with (October 27, 2026): the live address, and the inbox
    kept on each purchase record, found by the account or, after the purge, by the Stripe
    customer that paid. A tombstoned address is never one of them."""
    keys: set[str] = set()
    conds = []
    if user_id is not None:
        user = db.get(User, user_id)
        if user is not None and user.deleted_at is None:
            keys.add(purchase_block_key(user.email))
        conds.append(PurchaseConsent.user_id == user_id)
    if customer:
        conds.append(PurchaseConsent.stripe_customer_id == customer)
    if conds:
        keys.update(
            k
            for k in db.scalars(
                select(PurchaseConsent.inbox_key).where(
                    or_(*conds), PurchaseConsent.inbox_key.is_not(None)
                )
            )
            if k
        )
    return keys


def is_blocked(db: DbSession, user: User) -> bool:
    """True when this account may not buy: its inbox, or any inbox it bought with, is blocked.
    So changing the email never lifts a block (October 27, 2026)."""
    keys = _inbox_keys(db, user.id)
    if not keys:
        return False
    return db.scalar(select(PurchaseBlock.id).where(PurchaseBlock.email_hash.in_(keys))) is not None


def block_purchases(
    db: DbSession, user_id: uuid.UUID | None, reason: str, *, customer: str | None = None
) -> None:
    """Keep every inbox this person bought with from buying again: the live address and the
    ones on their purchase records, so a deleted account (its address tombstoned) or a purged
    one (found by the Stripe customer) is blocked too (October 27, 2026)."""
    for key in sorted(_inbox_keys(db, user_id, customer)):
        _block_key(db, key, reason)
    db.flush()


def _block_key(db: DbSession, key: str, reason: str) -> None:
    if db.scalar(select(PurchaseBlock.id).where(PurchaseBlock.email_hash == key)) is None:
        db.add(PurchaseBlock(email_hash=key, reason=reason))
        db.flush()


def carry_block(db: DbSession, user: User, old_email: str) -> None:
    """An email change on a blocked account blocks the new inbox too, so changing the address,
    deleting and signing up again with it can't buy (October 27, 2026)."""
    old = db.scalar(
        select(PurchaseBlock).where(
            PurchaseBlock.email_hash.in_(_inbox_keys(db, user.id) | {purchase_block_key(old_email)})
        )
    )
    if old is not None:
        _block_key(db, purchase_block_key(user.email), old.reason)


# Stripe's own block lists, which its default Radar rules enforce on every payment.
BLOCK_LISTS = {
    "card": "card_fingerprint_blocklist",
    "us_bank_account": "us_bank_account_fingerprint_blocklist",
}


def block_payer(charge_id: str, charge: dict[str, Any] | None = None) -> bool:
    """Add the card or bank account behind a charge to Stripe's block list, so it can't pay
    again under another email. The inbox block is the one Qash holds, so this never fails the
    webhook; but a block that couldn't be added (the list missing, Stripe refusing or
    unreachable) is said to the admins, never silent (October 27, 2026). Already listed is
    fine. True when the card or account is on the list afterwards."""
    if not charge_id:
        return False
    try:
        charge = charge or _get(f"/charges/{charge_id}")
        details = charge.get("payment_method_details") or {}
        kind = str(details.get("type") or "")
        alias = BLOCK_LISTS.get(kind)
        fingerprint = str((details.get(kind) or {}).get("fingerprint") or "")
        if alias is None or not fingerprint:
            return False  # a payment method Stripe has no block list for
        lists = _get("/radar/value_lists", {"alias": alias}).get("data") or []
        if not lists:
            _report_block("radar_block_missing_list")
            return False
        value_list = str(lists[0]["id"])
        listed = _get("/radar/value_list_items", {"value_list": value_list, "value": fingerprint})
        if listed.get("data"):
            return True
        _post(
            "/radar/value_list_items", {"value_list": value_list, "value": fingerprint}
        )  # no idempotency key: a block lifted by hand can be added again the same day
        return True
    except (BillingError, httpx2.HTTPError) as exc:
        _report_block("radar_block_failed", exc)
        return False


def _report_block(kind: str, exc: Exception | None = None) -> None:
    from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

    report(kind, "block_payer", exc)


def _lock_person(db: DbSession, user_id: uuid.UUID) -> None:
    """Take the person's row before touching their plans, in the same order as account
    deletion (which locks it fully), so a webhook racing a deletion waits rather than
    deadlocking. FOR NO KEY UPDATE: it doesn't block a plan change recording its history."""
    db.execute(select(User.id).where(User.id == user_id).with_for_update(key_share=True))


# One lock for the whole Founding offer (a Postgres advisory lock, held to the end of the
# transaction): the count of places and the row that takes one happen under it, so two buyers
# paying for the last place at once can't both get it; the second waits and is refunded.
FOUNDING_LOCK = 51_007_250


def founding_over_cap(db: DbSession, *, exclude: str) -> bool:
    """True when the Founding places are all taken by purchases other than `exclude`. Takes the
    offer's lock first, so the caller's insert is counted by the next buyer."""
    db.execute(select(func.pg_advisory_xact_lock(FOUNDING_LOCK)))
    return founding_taken(db, exclude=exclude) >= int(load_plans()["founding"]["cap"])


def _refund_oversold(db: DbSession, user_id: uuid.UUID, payment_intent: str, customer: Any) -> str:
    """A Founding payment after the last place went: refunded in full (our timing, so no fee)
    and the plan isn't granted. A Stripe error raises, so the webhook fails and Stripe retries;
    the refund's tag keeps that retry from paying twice."""
    refund_payment(
        payment_intent,
        int(load_plans()["founding"]["one_time_cents"]),
        key=f"founding_sold_out:{payment_intent}",
        fee=False,
    )
    user = db.get(User, user_id)
    if user is not None and user.deleted_at is None:
        get_sender().send(founding_sold_out_message(user.email))
    return "founding_sold_out"


def _subscription_event(
    db: DbSession, kind: str, obj: dict[str, Any], *, created: datetime, now: datetime
) -> str:
    external_id = str(obj.get("id") or "")
    owner = _user_id((obj.get("metadata") or {}).get("user_id")) or db.scalar(
        select(Subscription.user_id).where(Subscription.external_id == external_id)
    )
    if owner:
        _lock_person(db, owner)
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    if row is not None:
        if row.last_event_at is not None and created < row.last_event_at:
            return "stale"  # an older event delivered late: what we have is newer
        if row.stripe_status == "canceled" and not kind.endswith("deleted"):
            return "stale"  # Stripe never reopens a canceled subscription
        if row.last_event_at is not None and created == row.last_event_at:
            # Stripe dates events to the second and may deliver them in any order, so two in
            # the same second (a cancel then a resume, a switch's two updates) can't be ordered
            # by date: apply the subscription as Stripe holds it now (October 25, 2026). If
            # Stripe can't be reached, the webhook fails and Stripe sends it again later.
            obj = _current_subscription(external_id, obj)
    metadata = obj.get("metadata") or {}
    user_id = _user_id(metadata.get("user_id")) or (row.user_id if row else None)
    if not user_id:
        return "ignored"
    plan = metadata.get("plan") or (row.plan if row else None)
    interval = metadata.get("interval") or (row.interval if row else None)
    items = (obj.get("items") or {}).get("data") or []
    price_id = ((items[0].get("price") or {}).get("id") if items else None) or None
    mapped = plan_for_price(price_id) if price_id else None
    if mapped:
        plan, interval = mapped
    if plan not in ("private", "connected"):
        return "ignored"
    stripe_status = "canceled" if kind.endswith("deleted") else str(obj.get("status") or "active")
    status = _status(stripe_status)
    end = period_end(obj)
    if status == "canceled":
        # Ended means ended (deleted, or unpaid / incomplete_expired after failed payments):
        # Stripe's own end time, not the period's, which a failed renewal has already moved a
        # month or a year ahead (October 24, 2026). A plan cancelled at the period's end ends
        # there anyway.
        ended = _epoch(obj.get("ended_at")) or _epoch(obj.get("canceled_at")) or now
        end = min(end, ended) if end else ended
    if status == "canceled" and row is not None and row.status != "canceled":
        plan_history.add(db, user_id, "ended", plan, interval, at=now)
    # Stripe calls a subscription active while its first bank debit is still clearing; when its
    # creation arrives before the checkout says so, the first invoice tells (October 25, 2026).
    clearing = row is None and status == "active" and _first_invoice_open(obj)
    row = _upsert(
        db,
        external_id=external_id,
        user_id=user_id,
        plan=plan,
        status=status,
        interval=interval,
        customer_id=obj.get("customer") or (row.customer_id if row else None),
        renews_at=None if status == "canceled" else end,
        ends_at=(end or now) if status == "canceled" else None,
        cancel_at_period_end=bool(obj.get("cancel_at_period_end")),
    )
    row.last_event_at = created
    row.stripe_status = stripe_status
    if clearing and row.first_payment is None:
        row.first_payment = "pending"
    db.flush()
    store_entitlements(db, user_id)
    return status


def _first_invoice_open(obj: dict[str, Any]) -> bool:
    """True when the subscription's latest invoice is still open, as it is while a bank debit
    clears (a card payment, or a trial's $0 invoice, is paid at once)."""
    invoice = obj.get("latest_invoice")
    if isinstance(invoice, dict):
        return invoice.get("status") == "open"
    if not isinstance(invoice, str) or not invoice:
        return False
    return _get(f"/invoices/{invoice}").get("status") == "open"


def _current_subscription(external_id: str, delivered: dict[str, Any]) -> dict[str, Any]:
    """The subscription as Stripe holds it now; the delivered copy only if Stripe answers with
    something that isn't this subscription."""
    current = _get(f"/subscriptions/{external_id}")
    return current if current.get("id") == external_id else delivered


def _user_id(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _upsert(
    db: DbSession,
    *,
    external_id: str,
    user_id: uuid.UUID,
    plan: str,
    status: str,
    interval: str | None,
    customer_id: str | None,
    renews_at: datetime | None,
    ends_at: datetime | None,
    cancel_at_period_end: bool,
) -> Subscription:
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    if row is None:
        row = Subscription(
            user_id=user_id, source="stripe", external_id=external_id, plan=plan, status=status
        )
        db.add(row)
    row.plan = plan
    row.status = status
    row.interval = interval
    row.customer_id = customer_id or row.customer_id
    row.renews_at = renews_at
    row.ends_at = ends_at
    row.cancel_at_period_end = cancel_at_period_end
    db.flush()
    return row
