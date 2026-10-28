"""Give a test user a plan without Stripe: a subscription row, as a webhook would create it."""

import uuid
from datetime import UTC, datetime, timedelta

from app.db import get_session_factory
from app.models.billing import Subscription
from app.rules_server.entitlements import store_entitlements


def grant_plan(user_id: str, plan: str, *, interval: str = "yearly") -> None:
    with get_session_factory()() as s, s.begin():
        s.add(
            Subscription(
                user_id=uuid.UUID(user_id),
                plan=plan,
                source="stripe",
                external_id=f"test_{uuid.uuid4().hex}",
                customer_id=f"cus_{uuid.uuid4().hex[:12]}",
                status="active",
                interval=None if plan == "founding" else interval,
                renews_at=None if plan == "founding" else datetime.now(UTC) + timedelta(days=365),
                ends_at=datetime.now(UTC) + timedelta(days=365 * 4 + 1)
                if plan == "founding"
                else None,
            )
        )
        s.flush()
        store_entitlements(s, uuid.UUID(user_id))


# Consent text comes from the server (October 28, 2026): a test agrees to the lines the server
# built for the offer, as the app does. PLACEHOLDER_CONSENT is for requests refused before the
# words are compared (no plan, a plan already held, blocked, a stale version, unticked).
PLACEHOLDER_CONSENT = {
    "version": "2026-10-24",
    "lines": ["Words the server never wrote."],
    "agreement": "I agree.",
    "accepted": True,
}


def _agreed(offer: dict) -> dict:
    return {
        "version": offer["version"],
        "lines": offer["lines"],
        "agreement": offer["agreement"],
        "accepted": True,
    }


def purchase_consent(client, plan: str | None, interval: str | None = None) -> dict:
    params = {k: v for k, v in (("plan", plan), ("interval", interval)) if v}
    r = client.get("/api/billing/consent/purchase", params=params)
    return _agreed(r.json()) if r.status_code == 200 else PLACEHOLDER_CONSENT


def cancel_consent(client) -> dict:
    r = client.get("/api/billing/consent/cancel")
    return _agreed(r.json()) if r.status_code == 200 else PLACEHOLDER_CONSENT


def change_consent(client, plan: str, interval: str) -> dict:
    r = client.post("/api/billing/change/preview", json={"plan": plan, "interval": interval})
    return _agreed(r.json()["consent"]) if r.status_code == 200 else PLACEHOLDER_CONSENT
