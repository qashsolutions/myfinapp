"""Why a lapsed account's plan ended: the one reading that both the ended email and the Plan
screen use, so the two never name it differently (invariant 73, October 30, 2026).

- `payment_returned`: the bank flagged the payment and it was refunded; this inbox may not buy
  again.
- `holder_lost`: the partner's plan covered them and ended over its holder's payment (never
  said why).
- `cover_ended` / `cover_switched`: a household's plan stopped covering them (they or the
  holder left, or the holder moved to a plan without household); their own 7 days.
- `founding`: a Founding term ran out.
- `trial`: a free trial ended (their own, or the household's).
- `plan`: a paid plan ended.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.billing import Subscription
from app.models.user import User
from app.rules_server.entitlements import household_pair
from app.services.stripe_billing import is_blocked

EndReason = Literal[
    "payment_returned",
    "holder_lost",
    "cover_ended",
    "cover_switched",
    "founding",
    "trial",
    "plan",
]


def end_reason(db: DbSession, user: User, state: dict[str, Any]) -> EndReason | None:
    """Why the plan in `state` (the account's `access`) ended; None unless it is lapsed."""
    if state.get("state") != "lapsed":
        return None
    ended: datetime = state["ended_at"]
    if is_blocked(db, user):
        return "payment_returned"
    pair = household_pair(db, user.id)
    plan_of = [user.id, *(pair or ())]
    others = [u for u in pair or () if u != user.id]
    if state.get("shared") == "covered" and _dispute_lost(db, others, ended):
        return "holder_lost"
    left = user.household_cover_ended_at is not None and user.household_cover_ended_at == ended
    if left and "shared" not in state:
        return "cover_switched" if pair is not None else "cover_ended"
    if _founding_ended(db, plan_of, ended):
        return "founding"
    if _trial_ended(db, plan_of, ended):
        return "trial"
    return "plan"


def _dispute_lost(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a dispute the household's holder lost."""
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id.in_(user_ids), Subscription.dispute_lost_at == ended
            )
        )
        is not None
    )


def _founding_ended(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a Founding term's (its own, or the household's)."""
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id.in_(user_ids),
                Subscription.plan == "founding",
                Subscription.ends_at == ended,
            )
        )
        is not None
    )


def _trial_ended(db: DbSession, user_ids: list[uuid.UUID], ended: datetime) -> bool:
    """Whether the end the account is in is a free trial's (its own, or the household's)."""
    return (
        db.scalar(select(User.id).where(User.id.in_(user_ids), User.trial_ends_at == ended))
        is not None
    )
