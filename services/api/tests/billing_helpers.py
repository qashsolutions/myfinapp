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
