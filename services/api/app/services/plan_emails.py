"""One email per plan change that says what changed (owner, November 24, 2026): bought, kept,
switched, cancelled or tested, the plan, the money, the dates and whether it renews. These
replace the bare "Your plan changed" alert; each still says where it was done."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, tzinfo
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.billing import Subscription
from app.models.notification import NotificationSettings
from app.models.user import User
from app.rules_server.entitlements import load_plans
from app.services import consent_text, stripe_billing
from app.services.email import (
    founding_subscribed_message,
    get_sender,
    plan_link,
    plan_subscribed_message,
)


def zone_for(db: DbSession, user_id: uuid.UUID, tz_name: str | None) -> tzinfo:
    """The device's zone when it sent one, else the one Alerts keep, else UTC."""
    if tz_name:
        return consent_text.zone(tz_name)
    saved = db.scalar(
        select(NotificationSettings.timezone).where(NotificationSettings.user_id == user_id)
    )
    return consent_text.zone(saved)


def done_on(device_label: str, tz: tzinfo, at: datetime | None = None) -> str:
    """ "Chrome on Mac, Nov 24, 2026 at 10:20 PM CST" on the person's own clock."""
    local = (at or datetime.now(UTC)).astimezone(tz)
    hour = local.hour % 12 or 12
    clock = f"{hour}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'} {local.tzname()}"
    return f"{device_label}, {consent_text.day(local, tz)} at {clock}"


def every(interval: str | None) -> str:
    return "year" if interval == "yearly" else "month"


def plan_name(plan: str, interval: str | None) -> str:
    """ "Private · monthly"."""
    label = str(load_plans()["plans"][plan]["label"])
    return f"{label} · {interval}" if interval else label


def price_cents(plan: str, interval: str | None) -> int:
    return int(load_plans()["plans"][plan]["price_cents"][interval or "monthly"])


def price_line(plan: str, interval: str | None) -> str:
    """ "$3.00 a month"."""
    return f"{consent_text.money(price_cents(plan, interval))} a {every(interval)}"


def invoice_link(subscription_id: str | None) -> str | None:
    if not subscription_id:
        return None
    try:
        return stripe_billing.invoice_summary(subscription_id)[1]
    except stripe_billing.BillingError:
        return None


def send_subscribed(db: DbSession, user_id: uuid.UUID, obj: dict[str, Any]) -> None:
    """After the checkout webhook granted a plan (once per event: redeliveries are
    "duplicate"). Stripe out of reach leaves the invoice link out, never the email."""
    user = db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        return
    tz = zone_for(db, user_id, None)
    now = datetime.now(UTC)
    if obj.get("mode") == "payment":
        row = db.scalar(
            select(Subscription)
            .where(Subscription.user_id == user_id, Subscription.plan == "founding")
            .order_by(Subscription.created_at.desc())
        )
        founding = load_plans()["founding"]
        get_sender().send(
            founding_subscribed_message(
                user.email,
                plan_link(),
                price=consent_text.money(int(founding["one_time_cents"])),
                started=consent_text.day(now, tz),
                until=consent_text.day(row.ends_at, tz) if row and row.ends_at else "",
                years=int(founding["term_years"]),
                invoice_link=None,
            )
        )
        return
    external_id = str(obj.get("subscription") or "")
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    if row is None:
        return
    try:
        live: dict[str, Any] = stripe_billing.get_subscription(external_id)
    except stripe_billing.BillingError:
        live = {}
    renews = stripe_billing.period_end(live) if live else row.renews_at
    trial_end = int(live.get("trial_end") or 0)
    free_until = (
        consent_text.day(datetime.fromtimestamp(trial_end, UTC), tz)
        if trial_end > now.timestamp()
        else None
    )
    amount = consent_text.money(price_cents(row.plan, row.interval))
    started = live.get("start_date")
    get_sender().send(
        plan_subscribed_message(
            user.email,
            plan_link(),
            plan=plan_name(row.plan, row.interval),
            price=price_line(row.plan, row.interval),
            started=consent_text.day(
                datetime.fromtimestamp(int(started), UTC) if started else now, tz
            ),
            free_until=free_until,
            next_charge=f"{amount} on {consent_text.day(renews, tz)}" if renews else amount,
            every=every(row.interval),
            invoice_link=invoice_link(external_id),
        )
    )
