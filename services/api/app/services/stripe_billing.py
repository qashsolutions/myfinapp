"""Stripe billing (docs/spec.md "Plans & billing"): hosted Checkout, the Customer Portal and
webhooks, called through `outbound_client` as plain REST so only api.stripe.com is ever
contacted and no SDK brings its own HTTP stack. The server never sees card details.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
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
from app.models.billing import (
    BillingEvent,
    CheckoutPage,
    PurchaseBlock,
    PurchaseConsent,
    Subscription,
)
from app.models.user import User
from app.rules_server.entitlements import (
    FOREIGN_CARD,
    REFUSED,
    access,
    covered_members,
    end_lost_cover,
    founding_taken,
    household_pair,
    is_tester,
    load_plans,
    purchase_conflict,
    release_split_pauses,
    store_entitlements,
)
from app.security.hashing import pseudonym
from app.security.outbound import outbound_client
from app.services import plan_history
from app.services.email import (
    bank_payment_failed_message,
    dispute_admin_message,
    foreign_card_refunded_message,
    founding_sold_out_message,
    fraud_admin_message,
    fraud_refund_message,
    get_sender,
    household_plan_paused_message,
    household_plan_resumed_message,
    plan_ended_dispute_lost_message,
    plan_link,
    plan_paused_message,
    plan_resumed_message,
    second_plan_refunded_message,
)
from app.services.otp import canonical_email

STRIPE_API = "https://api.stripe.com/v1"
# Every request names the API version it was written and tested against (October 30, 2026),
# the same one the live webhook endpoint is set to, so a change to the account's default in
# the Dashboard never changes what Stripe sends back. Upgrading means a new value here, the
# endpoint's version set to match, and `e2e:payments` passing against it.
STRIPE_VERSION = "2026-09-30.endive"
log = logging.getLogger("stackd.billing")
SIGNATURE_TOLERANCE_SECONDS = 300
transport_override: httpx2.BaseTransport | None = None


class BillingError(Exception):
    """`code` is ours and stable; `detail` (when Stripe answered) is Stripe's HTTP status and
    its own error code, such as "429 lock_timeout", for the log and the ops email. Never
    Stripe's message, which can quote what it was sent."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(code)
        self.code = code
        self.detail = detail


_STRIPE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


def _stripe_failure(response: httpx2.Response, code: str = "stripe_error") -> BillingError:
    """A BillingError carrying Stripe's status and error code (only when it has the shape of
    one of Stripe's codes, so nothing else in the body is ever copied)."""
    try:
        error = (response.json() or {}).get("error") or {}
    except ValueError:
        error = {}
    found = (error.get("code") or error.get("type")) if isinstance(error, dict) else None
    tag = str(found) if found and _STRIPE_CODE.fullmatch(str(found)) else "-"
    return BillingError(code, f"{response.status_code} {tag}")


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
    try:
        with outbound_client(**kwargs) as client:
            return client.request(
                method,
                f"{STRIPE_API}{path}",
                data=form,
                headers={
                    "Authorization": f"Bearer {s.stripe_secret_key.get_secret_value()}",
                    "Stripe-Version": STRIPE_VERSION,
                    **({"Idempotency-Key": idempotency_key} if idempotency_key else {}),
                },
            )
    except httpx2.HTTPError as exc:
        # No answer at all (connection, DNS, timeout) is the same outage as a 5xx: every
        # caller already handles BillingError, and deletion waits and retries (October 28,
        # 2026). Only the type is kept; the request carries the secret key.
        raise BillingError("stripe_unreachable", type(exc).__name__) from exc


def _post(path: str, form: dict[str, str], *, idempotency_key: str | None = None) -> dict[str, Any]:
    response = _request("POST", path, form, idempotency_key=idempotency_key)
    if response.status_code == 402:
        raise _stripe_failure(response, "payment_failed")  # declined; nothing changed
    if response.status_code >= 400:
        raise _stripe_failure(response)
    return response.json()


def _get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    if params:
        path = f"{path}?{urlencode(params)}"
    response = _request("GET", path)
    if response.status_code >= 400:
        raise _stripe_failure(response)
    return response.json()


def _get_or_none(path: str, params: dict[str, str] | None = None) -> dict[str, Any] | None:
    """As `_get`, but a 404 (Stripe has no such object) is None rather than an error."""
    if params:
        path = f"{path}?{urlencode(params)}"
    response = _request("GET", path)
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise _stripe_failure(response)
    return response.json()


def set_collection_paused(subscription_id: str, paused: bool) -> None:
    """Pause or resume collecting payment on one subscription (owner decision, October 29,
    2026: while a payment on it is disputed). Paused, Stripe voids each invoice it would have
    charged, so nothing is taken for a plan that isn't working. A subscription Stripe no
    longer has (404) needs neither."""
    form = {"pause_collection[behavior]": "void"} if paused else {"pause_collection": ""}
    response = _request("POST", f"/subscriptions/{subscription_id}", form)
    if response.status_code < 400 or response.status_code == 404:
        return
    # Safe to repeat (invariant 60, October 29, 2026): a redelivered or second closing event
    # finds the subscription already as asked, or ended, and that is done, not a failure.
    failure = _stripe_failure(response)
    if response.status_code == 429 or response.status_code >= 500:
        raise failure  # Stripe busy or down: the webhook answers 5xx and Stripe retries
    live = _get_or_none(f"/subscriptions/{subscription_id}")
    if live is None or _collection_as_asked(live, paused):
        return
    raise failure


def _collection_as_asked(live: dict[str, Any], paused: bool) -> bool:
    """The subscription already collects (or not) as asked, or no longer bills at all."""
    if str(live.get("status") or "") in ("canceled", "incomplete_expired"):
        return True
    pause = live.get("pause_collection")
    return bool(pause) == paused


def cancel_now(subscription_id: str, *, prorate: bool = False) -> None:
    """End a subscription at once (account deletion). With `prorate`, the unused part of the
    paid period goes onto the customer's credit balance, which `refund_credit` then pays back.
    A subscription Stripe no longer has (404) counts as ended."""
    form = {"prorate": "true", "invoice_now": "true"} if prorate else None
    response = _request("DELETE", f"/subscriptions/{subscription_id}", form)
    if response.status_code >= 400 and response.status_code != 404:
        raise _stripe_failure(response)


# Nothing is charged until a trial ends, whenever the person subscribes during it (owner
# decision, October 28, 2026). Stripe needs a trial end at least 48 hours ahead; closer than
# this the billing cycle is anchored on the trial end instead, with no proration, so the first
# invoice is $0 and the first charge is on the trial-end day. Under ANCHOR_MIN (Stripe's
# shortest payment page, which must close before the anchor) the trial is all but over and the
# first charge is today. consent_text repeats both values and says the same.
TRIAL_END_MIN = timedelta(hours=49)
ANCHOR_MIN = timedelta(minutes=31)
CHECKOUT_MAX = timedelta(hours=24)  # Stripe's longest payment page (and its default)

# Every payment page closes after this (Stripe refuses under 30 minutes from its clock): a
# Founding one so open pages can't outlast the places left (October 24, 2026), and every
# subscription one (October 29, 2026) so a page left open in another tab can't be paid a day
# later beside a plan bought since. Equal to ANCHOR_MIN, so a trial's anchored page always
# closes before the anchor.
CHECKOUT_MINUTES = ANCHOR_MIN

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
    # A short window (Stripe's minimum) for every page; the webhook checks again what a paid
    # page may grant (the Founding places left, a plan bought since).
    expires = datetime.now(UTC) + CHECKOUT_MINUTES
    form["expires_at"] = str(int(expires.timestamp()))
    if plan == "founding":
        # So a fraud warning that lands before the checkout's own webhook still finds the person.
        form["payment_intent_data[metadata][user_id]"] = str(user.id)
    if plan != "founding":
        form["subscription_data[metadata][user_id]"] = str(user.id)
        form["subscription_data[metadata][plan]"] = plan
        form["subscription_data[metadata][interval]"] = interval or ""
        left = trial_ends_at - datetime.now(UTC) if trial_ends_at is not None else None
        if trial_ends_at is not None and left is not None and left >= TRIAL_END_MIN:
            form["subscription_data[trial_end]"] = str(int(trial_ends_at.timestamp()))
        elif trial_ends_at is not None and left is not None and left >= ANCHOR_MIN:
            form["subscription_data[billing_cycle_anchor]"] = str(int(trial_ends_at.timestamp()))
            form["subscription_data[proration_behavior]"] = "none"
            # The page closes by the trial end, so it is never paid after the anchor.
            close = min(expires, trial_ends_at)
            form["expires_at"] = str(int(close.timestamp()))
    if customer_id:
        form["customer"] = customer_id
    else:
        form["customer_email"] = user.email
        if plan == "founding":
            # A one-time payment makes no customer unless asked: without one, a Founding
            # member could never open receipts in the portal (found by the payments e2e).
            form["customer_creation"] = "always"
    return _post("/checkout/sessions", form)


def expire_checkout(session_id: str) -> None:
    """Close one payment page so it can no longer be paid. A page Stripe has already closed
    (paid, expired, or unknown) answers 4xx, which is fine; no answer, or a 5xx, raises, so a
    new page is never opened while an older one may still be paid."""
    response = _request("POST", f"/checkout/sessions/{session_id}/expire")
    if response.status_code >= 500:
        raise _stripe_failure(response)


def close_open_pages(db: DbSession, user_id: uuid.UUID, *, now: datetime | None = None) -> int:
    """Before a new payment page opens, close every other page this person may still pay
    (October 29, 2026): two pages opened at once (two tabs, two devices) could otherwise both
    be paid, each checked only against the plans that existed when it opened. Returns how
    many were closed."""
    now = now or datetime.now(UTC)
    pages = db.scalars(
        select(CheckoutPage).where(CheckoutPage.user_id == user_id, CheckoutPage.expires_at > now)
    ).all()
    for page in pages:
        expire_checkout(page.session_id)
        page.expires_at = now  # closed: never asked again
    db.flush()
    return len(pages)


def remember_page(db: DbSession, user_id: uuid.UUID, session: dict[str, Any]) -> None:
    """Keep the page just opened until it closes (`expires_at`, Stripe's or ours)."""
    if not session.get("id"):
        return
    closes = _epoch(session.get("expires_at")) or datetime.now(UTC) + CHECKOUT_MAX
    db.add(CheckoutPage(user_id=user_id, session_id=str(session["id"]), expires_at=closes))
    db.flush()


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
    if sub.first_payment in ("pending", REFUND_ALL):
        # The first bank payment hadn't cleared, so the plan never started (owner decision,
        # October 29, 2026): all of it comes back once it clears, no months, no fee.
        return clearing_refund(sub), None
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


# A row whose first bank payment was still clearing when the account was deleted: its refund
# is the whole payment, paid once it clears (owner decision, October 29, 2026).
REFUND_ALL = "refund_all"


def clearing_refund(sub: Subscription) -> int:
    """The whole first payment of a plan that never started: Founding's price, or the plan's
    price for its interval (as charged: the first item's price at Stripe when it answers)."""
    plans = load_plans()
    if sub.interval is None:
        return int(plans["founding"]["one_time_cents"])
    listed = int(plans["plans"][sub.plan]["price_cents"][sub.interval])
    if not sub.external_id:
        return listed
    live = _get_or_none(f"/subscriptions/{sub.external_id}") or {}
    items = (live.get("items") or {}).get("data") or []
    amount = ((items[0].get("price") or {}).get("unit_amount")) if items else None
    return int(amount) if amount else listed


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
    """ "card" or "bank": how the customer's newest payment was made (one still clearing
    counts, so the fee promised is the one taken once it clears)."""
    charges = _get("/charges", {"customer": customer_id, "limit": "100"}).get("data") or []
    paid = _newest_paid(charges)
    if paid is None:
        clearing = [c for c in charges if c.get("status") == "pending"]
        paid = max(clearing, key=lambda c: int(c.get("created") or 0)) if clearing else None
    return _method_of(paid)


def charges_clearing(customer_id: str) -> bool:
    """True while a payment of this customer is still on its way (a US bank debit takes up to
    4 business days, October 29, 2026): what it pays can't be refunded until it arrives."""
    charges = _get("/charges", {"customer": customer_id, "limit": "100"}).get("data") or []
    return any(c.get("status") == "pending" for c in charges)


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


def _invoice_payments(invoice_id: str) -> list[dict[str, Any]]:
    """The payments made on one invoice that have arrived (`paid`), from Stripe's invoice
    payments (a charge no longer names its invoice)."""
    data = _get("/invoice_payments", {"invoice": invoice_id, "limit": "10"}).get("data") or []
    return [p for p in data if p.get("status") == "paid"]


def refund_invoice(invoice_id: str, *, key: str) -> int:
    """Refund in full, with no fee (our doing), every payment that arrived on one invoice, at
    most once for `key` per payment. A payment still clearing is refunded when it arrives (the
    caller asks again then). Returns cents refunded now."""
    total = 0
    for payment in _invoice_payments(invoice_id):
        intent = str((payment.get("payment") or {}).get("payment_intent") or "")
        cents = int(payment.get("amount_paid") or 0)
        if not intent or cents <= 0:
            continue
        tag = f"{key}:{intent}"
        done = _tagged_refunds({"payment_intent": intent})
        if any((r.get("metadata") or {}).get(REFUND_TAG) == tag for r in done):
            continue
        _refund({"payment_intent": intent}, cents, tag)
        total += cents
    return total


def first_invoice_of(subscription_id: str, hint: Any = None) -> str | None:
    """The invoice a new subscription opened with: the one Stripe named (a checkout's
    `invoice`, a subscription's `latest_invoice`), else the subscription's latest."""
    if isinstance(hint, dict):
        hint = hint.get("id")
    if isinstance(hint, str) and hint:
        return hint
    sub = _get_or_none(f"/subscriptions/{subscription_id}")
    latest = (sub or {}).get("latest_invoice")
    if isinstance(latest, dict):
        latest = latest.get("id")
    return str(latest) if latest else None


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
    """Stripe's scheme: HMAC-SHA256 over "{t}.{payload}"; a five-minute tolerance on t. While
    a secret is rolled Stripe sends one v1 per secret, so any one matching is enough."""
    now = now or time.time()
    pairs = [p.split("=", 1) for p in header.split(",") if "=" in p]
    timestamp = next((v for k, v in pairs if k.strip() == "t"), None)
    signatures = [v.strip() for k, v in pairs if k.strip() == "v1" and v.strip()]
    if not timestamp or not signatures or not timestamp.isdigit():
        raise BillingError("bad_signature")
    if abs(now - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        raise BillingError("bad_signature")
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    # Every value is compared (no early exit), so the time taken says nothing about which.
    matched = [hmac.compare_digest(expected, s) for s in signatures]
    if not any(matched):
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

# Credit and debit cards issued by a US bank only (owner decision, October 17, 2026; invariant
# 75). Pricing only in dollars doesn't do it: a card from any country pays a dollar price. Radar
# Lite has no custom rules, so the check is ours (October 30, 2026): a purchase paid with a card
# from elsewhere never starts, its subscription ends at once and anything it took comes back in
# full. A US bank account is US by nature.
HOME_COUNTRY = "US"


def payer_country(
    *, payment_intent: str | None = None, subscription: str | dict[str, Any] | None = None
) -> str | None:
    """The country of the card (or bank account) that pays for a purchase: from its payment
    method (a one-time payment's, else the subscription's default, which Checkout sets even
    when a trial charges nothing yet), else from what it charged. Link's method names no
    country but its charge names the card or bank behind it (October 30, 2026). None when
    neither says (a trial through Link, nothing charged yet). A Stripe outage raises, so the
    webhook is sent again."""
    charge: Any = None
    invoice: Any = None
    if payment_intent:
        intent = (
            _get_or_none(f"/payment_intents/{payment_intent}", {"expand[]": "latest_charge"}) or {}
        )
        method, charge = intent.get("payment_method"), intent.get("latest_charge")
    else:
        holder = subscription
        if isinstance(holder, str):
            holder = _get_or_none(f"/subscriptions/{holder}")
        holder = holder or {}
        method, invoice = holder.get("default_payment_method"), holder.get("latest_invoice")
    if isinstance(method, str) and method:
        method = _get_or_none(f"/payment_methods/{method}")
    if isinstance(method, dict) and (country := _country_of(method)):
        return country
    if charge is None and invoice:
        charge = _first_charge_of(invoice)
    if isinstance(charge, dict):
        return _country_of(charge.get("payment_method_details") or {})
    return None


def _country_of(method: dict[str, Any]) -> str | None:
    """A payment method's (or a charge's method details') country; a US bank account is US."""
    kind = str(method.get("type") or "")
    if kind == "us_bank_account":
        return HOME_COUNTRY
    country = (method.get(kind) or {}).get("country") if kind else None
    return str(country).upper() if country else None


def _first_charge_of(invoice: Any) -> dict[str, Any] | None:
    """The charge that paid a subscription's first invoice, if anything was charged yet."""
    if isinstance(invoice, dict):
        invoice = invoice.get("id")
    if not isinstance(invoice, str) or not invoice:
        return None
    found = _get_or_none("/invoice_payments", {"invoice": invoice, "limit": "10"}) or {}
    for payment in found.get("data") or []:
        intent = str((payment.get("payment") or {}).get("payment_intent") or "")
        if payment.get("status") != "paid" or not intent:
            continue
        held = _get_or_none(f"/payment_intents/{intent}", {"expand[]": "latest_charge"}) or {}
        if isinstance(held.get("latest_charge"), dict):
            return held["latest_charge"]
    return None


def _foreign_payer(
    *, payment_intent: str | None = None, subscription: str | dict[str, Any] | None = None
) -> bool:
    """True only when the payer's country is known and isn't the US. An unknown country lets
    the purchase through (the terms still say US cards only) and is logged without details."""
    country = payer_country(payment_intent=payment_intent, subscription=subscription)
    if country is None:
        log.warning("payer country unknown; purchase allowed")
        return False
    return country != HOME_COUNTRY


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
        person = db.get(User, user_id)
        if person is None or person.deleted_at is not None:
            return _founding_after_deletion(db, person, external_id, held, customer, paid, now)
        if held is not None and held.first_payment in REFUSED:
            if paid:  # refused already; a bank payment that cleared since comes back
                _refund_refused(held.first_payment, external_id, "founding", None)
            return _outcome(held.first_payment)
        if purchase_conflict(db, user_id, "founding", exclude=external_id):
            # Two pages were open and both were paid (October 29, 2026): this one is refunded.
            return _refuse_purchase(
                db, person, external_id, "founding", None, customer, held, None, paid, now
            )
        if paid and _foreign_payer(payment_intent=str(obj.get("payment_intent") or "")):
            # A card from outside the US (invariant 75): no place taken, all of it back.
            return _refuse_purchase(
                db,
                person,
                external_id,
                "founding",
                None,
                customer,
                held,
                None,
                paid,
                now,
                reason=FOREIGN_CARD,
            )
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
    if row is not None and row.first_payment in REFUSED:
        if paid:  # refused already; a bank payment that cleared since comes back
            _refund_refused(row.first_payment, external_id, plan, obj.get("invoice"))
        return _outcome(row.first_payment)
    person = db.get(User, user_id)
    if person is None or person.deleted_at is not None:
        return _subscription_after_deletion(
            db, person, external_id, plan, interval, customer, row, obj.get("invoice"), paid, now
        )
    if purchase_conflict(db, user_id, plan, exclude=external_id):
        # Two pages were open and both were paid (October 29, 2026): the plan bought first
        # stays, this one ends now and its payment comes back in full.
        return _refuse_purchase(
            db, person, external_id, plan, interval, customer, row, obj.get("invoice"), paid, now
        )
    if paid and _foreign_payer(subscription=external_id):
        # A card from outside the US (invariant 75): the plan never starts, not even for the
        # moment before a later event; the subscription ends and anything charged comes back.
        return _refuse_purchase(
            db,
            person,
            external_id,
            plan,
            interval,
            customer,
            row,
            obj.get("invoice"),
            paid,
            now,
            reason=FOREIGN_CARD,
        )
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
            # No last_event_at: the checkout is not the subscription's own event, and its date
            # comes after the subscription's creation, which must still apply (October 28).
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
        # No last_event_at, as above: every subscription event, however dated, still applies.
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


def _outcome(first_payment: str | None) -> str:
    """What a refused purchase reports: why it was refused."""
    return "foreign_card" if first_payment == FOREIGN_CARD else "second_plan"


def _refund_refused(reason: str, external_id: str, plan: str, invoice: Any) -> None:
    """Refund a refused purchase's payment in full, no fee (our doing), at most once. Each
    reason has its own tag, so a refusal is never refunded twice under two names."""
    key = f"{_outcome(reason)}:{external_id}"
    if plan == "founding":
        intent = _get(f"/payment_intents/{external_id}")
        cents = int(intent.get("amount_received") or 0) or int(
            load_plans()["founding"]["one_time_cents"]
        )
        refund_payment(external_id, cents, key=key, fee=False)
        return
    if first := first_invoice_of(external_id, invoice):
        refund_invoice(first, key=key)


def _refuse_purchase(
    db: DbSession,
    person: User,
    external_id: str,
    plan: str,
    interval: str | None,
    customer: Any,
    row: Subscription | None,
    invoice: Any,
    paid: bool,
    now: datetime,
    *,
    reason: str = "refused",
) -> str:
    """A purchase that must not start: paid while another plan was already live (two pages
    open at once, October 29, 2026; invariant 41; `refused`), or paid with a card issued
    outside the US (October 30, 2026; invariant 75; `foreign_card`). Any earlier plan stays;
    this one is ended at Stripe now, its payment refunded in full (a bank payment once it
    clears), and its row kept with the reason, which never started. The person is told once,
    in plain words."""
    if plan != "founding":
        cancel_now(external_id)
    told = row is not None and row.first_payment == reason
    row = _upsert(
        db,
        external_id=external_id,
        user_id=person.id,
        plan=plan,
        status="expired" if plan == "founding" else "canceled",
        interval=interval,
        customer_id=customer,
        renews_at=None,
        ends_at=now,
        cancel_at_period_end=False,
    )
    row.stripe_status = "canceled"  # final: no later event reopens it
    row.first_payment = reason
    row.refund_due_cents = 0
    db.flush()
    if paid:
        _refund_refused(reason, external_id, plan, invoice)
    store_entitlements(db, person.id)
    if not told:
        message = (
            foreign_card_refunded_message
            if reason == FOREIGN_CARD
            else second_plan_refunded_message
        )
        get_sender().send(message(person.email, plan_link()))
    return _outcome(reason)


def _subscription_after_deletion(
    db: DbSession,
    person: User | None,
    external_id: str,
    plan: str,
    interval: str | None,
    customer: Any,
    row: Subscription | None,
    invoice: Any,
    paid: bool,
    now: datetime,
) -> str:
    """A subscription payment that lands after the account was deleted (a page paid after
    the deletion, or a bank payment that was clearing then; October 29, 2026, invariant 43):
    nothing is granted, the plan ends at Stripe, and what the deletion promised is refunded
    now through the deletion's own settling (`deletion.cancel_billing`, as of the deletion
    day: a payment made after it in full, the months after the kept one for a payment made
    before it). A Stripe error leaves it to the hourly settle."""
    if person is None:  # purged: no account to settle for, so it all goes back
        cancel_now(external_id)
        if paid and (first := first_invoice_of(external_id, invoice)):
            refund_invoice(first, key=f"after_purge:{external_id}")
        return "account_deleted"
    if row is None:
        row = _upsert(
            db,
            external_id=external_id,
            user_id=person.id,
            plan=plan,
            status="active",
            interval=interval,
            customer_id=customer,
            renews_at=None,
            ends_at=None,
            cancel_at_period_end=False,
        )
        row.first_payment = None if paid else "pending"
    # A row still "pending" stays so: the plan never started, so the deletion's settling
    # refunds the whole payment now that it has arrived (owner decision, October 29, 2026).
    row.customer_id = row.customer_id or customer
    db.flush()
    from app.services import deletion  # noqa: PLC0415 - deletion imports this module

    deletion.cancel_billing(db, person.id, now=now, as_of=person.deleted_at)
    return "account_deleted"


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
            # Nothing arrived, so a refund a deletion was waiting to pay from it is due no more
            # (the settle would otherwise wait on it for ever; October 29, 2026).
            row.refund_due_cents = 0
        db.flush()
    user = db.get(User, user_id)
    if user is not None and user.deleted_at is None:
        get_sender().send(bank_payment_failed_message(user.email, plan_link()))
    store_entitlements(db, user_id)
    return "payment_failed"


def subscription_of_charge(charge: dict[str, Any]) -> str | None:
    """The subscription one charge paid for: through its invoice (the charge's own `invoice`
    on older API versions, else the invoice payment of its payment intent) to the invoice's
    subscription. None for a payment that isn't a subscription's (Founding) or Stripe can't
    say."""
    invoice_id = charge.get("invoice")
    if isinstance(invoice_id, dict):
        invoice_id = invoice_id.get("id")
    intent = charge.get("payment_intent")
    if isinstance(intent, dict):
        intent = intent.get("id")
    if not invoice_id and intent:
        found = _get_or_none(
            "/invoice_payments",
            {"payment[type]": "payment_intent", "payment[payment_intent]": str(intent)},
        )
        data = (found or {}).get("data") or []
        invoice_id = data[0].get("invoice") if data else None
    if not invoice_id:
        return None
    invoice = _get_or_none(f"/invoices/{invoice_id}") or {}
    sub = invoice.get("subscription") or (
        ((invoice.get("parent") or {}).get("subscription_details") or {}).get("subscription")
    )
    if isinstance(sub, dict):
        sub = sub.get("id")
    return str(sub) if sub else None


def _rows_for_charge(db: DbSession, obj: dict[str, Any]) -> tuple[list[Subscription], str | None]:
    """The plan a disputed (or flagged) charge paid for, and the subscription Stripe says it
    paid for (October 29, 2026): Founding by its payment intent, a subscription through the
    charge's invoice, so another plan of the same customer is never touched. Only when Stripe
    can't name the subscription are the customer's Stripe plans used."""
    intent = str(obj.get("payment_intent") or "")
    rows = list(db.scalars(select(Subscription).where(Subscription.external_id == intent)))
    if rows or not obj.get("charge"):
        return rows, None
    charge = _get(f"/charges/{obj['charge']}")
    if sub_id := subscription_of_charge(charge):
        rows = list(db.scalars(select(Subscription).where(Subscription.external_id == sub_id)))
        return rows, sub_id
    customer = charge.get("customer")
    if not customer:
        return [], None
    rows = list(
        db.scalars(
            select(Subscription).where(
                Subscription.customer_id == str(customer), Subscription.source == "stripe"
            )
        )
    )
    return rows, None


def _row_from_stripe(db: DbSession, sub_id: str, now: datetime) -> Subscription | None:
    """A dispute on a subscription whose own events haven't arrived yet (Stripe's test cards
    dispute within seconds, October 29, 2026): the row is made from the subscription as Stripe
    holds it, so the pause applies and the late checkout completion finds it paused."""
    live = _get_or_none(f"/subscriptions/{sub_id}")
    if not live or live.get("id") != sub_id:
        return None
    owner = _user_id((live.get("metadata") or {}).get("user_id"))
    if owner is None or db.get(User, owner) is None:
        return None
    created = _epoch(live.get("created")) or now
    kind = "customer.subscription.updated"
    _subscription_event(db, kind, live, created=created, now=now)
    return db.scalar(select(Subscription).where(Subscription.external_id == sub_id))


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
    rows, sub_id = _rows_for_charge(db, obj)
    if not rows and sub_id and kind == "charge.dispute.created":
        made = _row_from_stripe(db, sub_id, now)
        rows = [made] if made is not None else []
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
            # Nothing is charged for a plan that isn't working (owner decision, October 29,
            # 2026): Stripe voids its renewals until the dispute closes.
            if _collects(r):
                assert r.external_id is not None
                set_collection_paused(r.external_id, True)
        outcome, message = "disputed", plan_paused_message
    else:
        status = str(obj.get("status") or "")
        if status in ("won", "warning_closed"):
            for r in rows:
                r.disputed_at = None
                if _collects(r):
                    assert r.external_id is not None
                    set_collection_paused(r.external_id, False)
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
        # A household that split while this was open: whoever stayed paused for it is on
        # their own from now, with their own 7 days (invariant 68).
        release_split_pauses(db, [r.id for r in rows], now=now)
    db.flush()
    for user_id in users:
        store_entitlements(db, user_id)
        user = db.get(User, user_id)
        if user is not None and user.deleted_at is None and message is not None:
            get_sender().send(message(user.email, plan_link()))
        # The partner the plan covers is paused and back with it (invariant 54); a lost
        # dispute ends the shared plan, and the plan job tells them as for any end.
        if outcome in ("disputed", "dispute_won"):
            _tell_covered_partner(db, user_id, outcome)
    if kind == "charge.dispute.created":
        _tell_admins_of_dispute(obj, matched=True)
    return outcome


def _tell_covered_partner(db: DbSession, user_id: uuid.UUID, outcome: str) -> None:
    """A household of two is one plan: the partner it covers hears it paused or came back."""
    pair = household_pair(db, user_id)
    for other_id in pair or ():
        other = db.get(User, other_id)
        if other is None or other.id == user_id or other.deleted_at is not None:
            continue
        if access(db, other).get("shared") != "covered":
            continue
        message = (
            household_plan_paused_message
            if outcome == "disputed"
            else household_plan_resumed_message
        )
        get_sender().send(message(other.email, plan_link()))


def _collects(row: Subscription) -> bool:
    """A Stripe subscription that still bills (not Founding, not ended)."""
    return bool(
        row.source == "stripe"
        and row.interval
        and row.external_id
        and row.status in ("active", "past_due")
        and row.stripe_status != "canceled"
    )


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
    rows, _ = _rows_for_charge(db, obj)
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


def _founding_after_deletion(
    db: DbSession,
    person: User | None,
    payment_intent: str,
    held: Subscription | None,
    customer: Any,
    paid: bool,
    now: datetime,
) -> str:
    """A Founding payment that lands after the account was deleted (a US bank payment takes up
    to 4 business days; owner decision, October 28, 2026): refunded in full (our timing, so no
    fee), at most once however often Stripe redelivers, and no plan is granted. Its row is
    closed (`canceled`, final), so the hourly settle has nothing left to do. A Stripe error
    raises, so the webhook fails and Stripe retries; the refund's tag keeps it to one."""
    if not paid:
        return "account_deleted"  # still clearing: nothing to refund, and no place is held
    refund_payment(
        payment_intent,
        int(load_plans()["founding"]["one_time_cents"]),
        key=f"founding_deleted:{payment_intent}",
        fee=False,
    )
    if held is None and person is not None:
        held = _upsert(
            db,
            external_id=payment_intent,
            user_id=person.id,
            plan="founding",
            status="canceled",
            interval=None,
            customer_id=customer,
            renews_at=None,
            ends_at=now,
            cancel_at_period_end=False,
        )
    if held is not None:
        held.status, held.stripe_status = "canceled", "canceled"
        held.ends_at = held.ends_at or now
        held.refund_due_cents = 0
        db.flush()
        store_entitlements(db, held.user_id)
    return "account_deleted"


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
    # Read before the change: a switch made at Stripe (not through /change) that leaves the
    # plan without household ends the partner's cover just the same (invariant 69).
    covered = covered_members(db, user_id, now=now)
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
    # A subscription starting here: new, or first announced `incomplete` (a payment still
    # being confirmed) and now live (review of #62, October 30, 2026).
    starting = status in ("active", "past_due") and (
        row is None or (row.status == "incomplete" and row.first_payment is None)
    )
    if starting:
        # A new subscription announced before its checkout (October 29, 2026): the same checks
        # as the checkout's completion, so neither a deleted account, a second plan beside a
        # live one nor a card from outside the US ever starts, whichever event comes first.
        person = db.get(User, user_id)
        customer, invoice = obj.get("customer"), obj.get("latest_invoice")
        if person is None or person.deleted_at is not None:
            return _subscription_after_deletion(
                db, person, external_id, plan, interval, customer, row, invoice, not clearing, now
            )
        if purchase_conflict(db, user_id, plan, exclude=external_id):
            return _refuse_purchase(
                db, person, external_id, plan, interval, customer, row, invoice, True, now
            )
        if not clearing and _foreign_payer(subscription=obj):
            return _refuse_purchase(
                db,
                person,
                external_id,
                plan,
                interval,
                customer,
                row,
                invoice,
                True,
                now,
                reason=FOREIGN_CARD,
            )
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
    end_lost_cover(db, covered, now=now)
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
