"""Plan → limits (docs/spec.md "Plans & billing"): every number comes from plans.yaml.

The effective plan is the user's active subscription (Founding members get Connected's
limits). Downgrading never deletes: the app makes items over the limit read-only; the server
refuses only new things (creating a group, joining past the cap).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.billing import Entitlement, Subscription
from app.models.household import Household, HouseholdMember
from app.models.trial_claim import TrialClaim, trial_hashes
from app.models.user import User

PLANS_PATH = Path(__file__).with_name("plans.yaml")
PLAN_NAMES = ("free", "private", "connected", "founding")
LIMIT_KEYS = (
    "goals_active_max",
    "statement_accounts_max",
    "groups_create",
    "groups_join_max",
    "bank_links_max",
    "backup",
    "household",
)


@lru_cache
def load_plans(path: Path = PLANS_PATH) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert set(data["plans"]) == {"free", "private", "connected"}, "plans.yaml: three plans"
    return data


def limits_for(plan: str) -> dict[str, Any]:
    data = load_plans()
    key = data["founding"]["grants"] if plan == "founding" else plan
    if key not in data["plans"]:
        raise ValueError(f"unknown plan {plan}")
    return {k: data["plans"][key][k] for k in LIMIT_KEYS}


def active_subscription(
    db: DbSession,
    user_id: uuid.UUID,
    *,
    now: datetime | None = None,
    exclude: str | None = None,
) -> Subscription | None:
    """The live subscription, newest first; a cancelled one still counts until it ends.
    `exclude`: a purchase (its Stripe id) to leave out, to ask what else is live beside it."""
    now = now or datetime.now(UTC)
    rows = db.scalars(
        select(Subscription)
        .where(Subscription.user_id == user_id)
        .order_by(Subscription.created_at.desc())
    ).all()
    for row in rows:
        if exclude is not None and row.external_id == exclude:
            continue
        if row.disputed_at is not None:
            continue  # paused while a payment on it is disputed
        if row.first_payment in ("pending", "failed", "refund_all"):
            continue  # a first bank payment that hasn't cleared (or never did)
        if row.status in ("active", "past_due"):
            if row.plan == "founding" and row.ends_at is not None and row.ends_at <= now:
                continue  # Founding is one payment for a fixed term: it ends with the term
            return row
        if row.status == "canceled" and row.ends_at is not None and row.ends_at > now:
            return row
    return None


def never_started(row: Subscription) -> bool:
    """A purchase whose money never arrived (a first bank debit that failed, or a Founding
    place given back, `expired`), or that was refunded in full as a second plan (`refused`).
    It leaves the account where it was (October 28, 2026)."""
    return row.first_payment in ("failed", "refused") or (
        row.plan == "founding" and row.status == "expired"
    )


def payment_pending(
    db: DbSession,
    user_id: uuid.UUID,
    *,
    now: datetime | None = None,
    exclude: str | None = None,
) -> bool:
    """A web purchase whose bank payment is still clearing: a subscription waiting on its
    first debit, or a Founding place held (`incomplete`). The plan waits for it, so does any
    other purchase (one helper for the Plan screen's "on its way" and checkout's 409). Two
    weeks bounds it, so a payment Stripe never reported on can't block buying for ever."""
    since = (now or datetime.now(UTC)) - timedelta(days=14)
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id == user_id,
                Subscription.source == "stripe",
                or_(Subscription.status == "incomplete", Subscription.first_payment == "pending"),
                Subscription.created_at >= since,
                *([Subscription.external_id.is_distinct_from(exclude)] if exclude else []),
            )
        )
        is not None
    )


def renewing(sub: Subscription | None) -> bool:
    """A live Stripe subscription that bills on a schedule (not Founding, not a store plan)."""
    return bool(
        sub
        and sub.source == "stripe"
        and sub.interval
        and sub.external_id
        and sub.status in ("active", "past_due")
    )


def purchase_conflict(
    db: DbSession, user_id: uuid.UUID, plan: str, *, exclude: str | None = None
) -> str | None:
    """Why buying `plan` now would make a second plan beside a live one (the 409 code), or
    None. Never two plans at once (October 17, 2026): checkout asks before a payment page
    opens, and the webhook asks again when one is paid (`exclude` = that purchase), since two
    pages opened at once could both be paid (October 29, 2026). Founding may follow a plan
    set not to renew; everything else waits until nothing else is live."""
    sub = active_subscription(db, user_id, exclude=exclude)
    if sub is not None and sub.plan == "founding":
        return "already_founding"
    if payment_pending(db, user_id, exclude=exclude):
        return "payment_pending"
    if sub is not None and sub.source in ("apple", "google"):
        if plan != "founding" or not sub.cancel_at_period_end:
            return "manage_in_store"
    if renewing(sub):
        assert sub is not None
        if plan != "founding":
            return "already_subscribed"
        if not sub.cancel_at_period_end:
            return "cancel_first"
    return None


TRIAL_PLANS = ("private", "connected")


def trial_settings() -> dict[str, Any]:
    return load_plans()["trials"]


def _ended_at(db: DbSession, user: User, now: datetime) -> datetime | None:
    """When this account last had a plan: the end of its trial or of its last paid period."""
    ends = [user.trial_ends_at] if user.trial_ends_at and user.trial_ends_at <= now else []
    # A household's plan stopped covering this person (they left, or the plan's holder did;
    # invariant 54): the 7 days start then, as when a plan of their own ends.
    if user.household_cover_ended_at and user.household_cover_ended_at <= now:
        ends.append(user.household_cover_ended_at)
    for row in db.scalars(select(Subscription).where(Subscription.user_id == user.id)):
        if never_started(row):
            continue  # a plan whose first payment never arrived never ended either
        end = row.ends_at or (row.updated_at if row.status in ("canceled", "expired") else None)
        if end is not None and end <= now:
            ends.append(end)
    return max(ends) if ends else None


LIVE_STATES = ("subscribed", "trial")


def household_pair(db: DbSession, user_id: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(the household's owner, the other member) when this person is in a household of two."""
    membership = db.scalar(
        select(HouseholdMember).where(
            HouseholdMember.user_id == user_id, HouseholdMember.left_at.is_(None)
        )
    )
    if membership is None:
        return None
    household = db.get(Household, membership.household_id)
    members = list(
        db.scalars(
            select(HouseholdMember.user_id)
            .where(
                HouseholdMember.household_id == membership.household_id,
                HouseholdMember.left_at.is_(None),
            )
            .order_by(HouseholdMember.joined_at, HouseholdMember.id)
        )
    )
    if household is None or len(members) != 2:
        return None
    owner = household.owner_id if household.owner_id in members else members[0]
    other = members[1] if members[0] == owner else members[0]
    return owner, other


def _covers(state: dict[str, Any]) -> bool:
    """A live plan of the person's own that includes couples & household."""
    return state["state"] in LIVE_STATES and bool(limits_for(state["plan"])["household"])


def household_holder(
    db: DbSession, pair: tuple[uuid.UUID, uuid.UUID], *, now: datetime
) -> uuid.UUID | None:
    """Whose plan covers the household of two (owner decision, October 29, 2026: "partner and
    owner use the same account for one price"): the owner's while their own plan (or trial)
    includes household; else the partner's, once the partner subscribes to such a plan of their
    own (the subscriber becomes the plan's holder); else nobody, and the plan has ended for both."""
    owner_id, other_id = pair
    owner = db.get(User, owner_id)
    if owner is not None and _covers(_own_access(db, owner, now=now)):
        return owner_id
    other = db.get(User, other_id)
    if other is not None:
        state = _own_access(db, other, now=now)
        if state["state"] == "subscribed" and _covers(state):
            return other_id
    return None


def access(db: DbSession, user: User, *, now: datetime | None = None) -> dict[str, Any]:
    """Where this account stands, a household of two counted as one plan (owner decision,
    October 29, 2026; invariant 54). The holder (`household_holder`) has their own state, marked
    `shared: "holder"`; the other is `subscribed` to the holder's plan, `shared: "covered"`: no
    trial clock, no card ask, no reminders of their own. When the household's plan has ended,
    the other has the holder's end too (`lapsed` from the same day, or `paused` while the
    holder's payment is disputed), so both get the same notices and the same 7 days. A person's
    own paid plan that includes household, and their own dispute, are always their own."""
    now = now or datetime.now(UTC)
    own = _own_access(db, user, now=now)
    pair = household_pair(db, user.id)
    if pair is None:
        return own
    holder = household_holder(db, pair, now=now)
    if holder == user.id or (own["state"] == "subscribed" and _covers(own)):
        return {**own, "shared": "holder"}
    if own["state"] in ("paused", "ended"):
        return own  # a dispute of their own is theirs alone
    if holder is not None:
        holder_user = db.get(User, holder)
        assert holder_user is not None
        plan = _own_access(db, holder_user, now=now)["plan"]
        return {"state": "subscribed", "plan": plan, "shared": "covered"}
    owner_id, _ = pair
    if own["state"] == "subscribed":
        return own  # a plan of their own without household: theirs to use
    if user.id == owner_id:
        return {**own, "shared": "holder"}
    owner = db.get(User, owner_id)
    assert owner is not None
    theirs = _own_access(db, owner, now=now)
    if theirs["state"] == "paused":
        return {
            "state": "paused",
            "plan": "free",
            "disputed_at": theirs["disputed_at"],
            "shared": "covered",
        }
    end = theirs.get("ended_at")
    if end is None:
        return own
    if own["state"] == "lapsed" and own["ended_at"] > end:
        end = own["ended_at"]
    return {
        "state": "lapsed",
        "plan": "free",
        "ended_at": end,
        "delete_at": end + timedelta(days=int(trial_settings()["grace_days"])),
        "shared": "covered",
    }


def _own_access(db: DbSession, user: User, *, now: datetime | None = None) -> dict[str, Any]:
    """What this account may do now on its own (owner decision, October 14, 2026):

    subscribed  a live paid plan (or Founding)
    trial       inside the free trial it picked; `card_from` is when the app starts asking for
                a card, `trial_ends_at` when it ends
    choose      a new account that has not picked a trial yet; `trial_used` says its inbox
                already had one (someone signing up again), so it can only buy a plan
    lapsed      a trial or paid period ended with no subscription: subscribe or export until
                `delete_at`, then the account is deleted
    paused      a payment is disputed with the bank (owner decision, October 24, 2026): the
                plan stops until the dispute is won or withdrawn; never deleted for it
    ended       a dispute was lost (owner decision, October 25, 2026): the plan has ended and
                the inbox can't buy again; the account stays open (download, erase or delete)
                and is never closed for it, so the terms' "nothing is deleted because of a
                dispute" holds
    """
    now = now or datetime.now(UTC)
    if testing := tester_plan(user):
        return {"state": "subscribed", "plan": testing}
    sub = active_subscription(db, user.id, now=now)
    if sub is not None:
        return {"state": "subscribed", "plan": sub.plan}
    if user.trial_plan and user.trial_ends_at and user.trial_ends_at > now:
        cfg = trial_settings()[user.trial_plan]
        # A trial keeps the length it started with (45 / 8 days before October 22, 2026, 3 since):
        # its length comes from when it was claimed, and the card ask counts back from its end.
        claimed = db.scalar(
            select(TrialClaim.claimed_at)
            .where(TrialClaim.email_hash.in_(trial_hashes(user.email)))
            .order_by(TrialClaim.claimed_at.desc())
            .limit(1)
        )
        days = (
            max(1, round((user.trial_ends_at - claimed).total_seconds() / 86400))
            if claimed is not None
            else int(cfg["days"])
        )
        ask_before = int(cfg["days"]) - int(cfg["card_from_day"]) + 1
        return {
            "state": "trial",
            "plan": user.trial_plan,
            "days": days,
            "trial_ends_at": user.trial_ends_at,
            "card_from": user.trial_ends_at - timedelta(days=ask_before),
        }
    disputed = db.scalar(
        select(Subscription.disputed_at)
        .where(
            Subscription.user_id == user.id,
            Subscription.disputed_at.is_not(None),
            Subscription.dispute_lost_at.is_(None),  # lost is final: ended, not paused
        )
        .order_by(Subscription.disputed_at.desc())
        .limit(1)
    )
    if disputed is not None:
        return {"state": "paused", "plan": "free", "disputed_at": disputed}
    lost = db.scalar(
        select(Subscription.dispute_lost_at)
        .where(Subscription.user_id == user.id, Subscription.dispute_lost_at.is_not(None))
        .order_by(Subscription.dispute_lost_at.desc())
        .limit(1)
    )
    if lost is not None:
        return {"state": "ended", "plan": "free", "ended_at": lost}
    ended = _ended_at(db, user, now)
    if ended is None:
        used = db.scalar(
            select(TrialClaim.id).where(TrialClaim.email_hash.in_(trial_hashes(user.email)))
        )
        return {"state": "choose", "plan": "free", "trial_used": used is not None}
    return {
        "state": "lapsed",
        "plan": "free",
        "ended_at": ended,
        "delete_at": ended + timedelta(days=int(trial_settings()["grace_days"])),
    }


def is_tester(user: User | None) -> bool:
    """An admin who may use the tester tools: the email is in STACKD_ADMIN_EMAILS."""
    if user is None or user.deleted_at is not None:
        return False
    admins = {e.strip().lower() for e in get_settings().admin_emails if e.strip()}
    return user.email.lower() in admins


def tester_plan(user: User | None) -> str | None:
    """The plan an admin chose to test with; None for everyone else."""
    return user.tester_plan if user is not None and user.tester_plan and is_tester(user) else None


def effective_plan(
    db: DbSession, user_id: uuid.UUID, *, tester: bool = True
) -> tuple[str, Subscription | None]:
    """The plan whose limits apply: an admin's tester plan (unless `tester` is False: billing
    always acts on the real subscription, so it also leaves out a household's shared plan), a
    live subscription, else the household's plan or the trial in progress, else "free" (no
    plan: choosing a trial, or lapsed)."""
    if tester and (testing := tester_plan(db.get(User, user_id))):
        return testing, None
    sub = active_subscription(db, user_id)
    if sub is not None:
        return sub.plan, sub
    user = db.get(User, user_id)
    if user is None:
        return "free", None
    if tester:
        # The limits that apply, a household's shared plan included (invariant 54).
        state = access(db, user)
        return (state["plan"], None) if state["state"] in LIVE_STATES else ("free", None)
    now = datetime.now(UTC)
    if user.trial_plan and user.trial_ends_at and user.trial_ends_at > now:
        return user.trial_plan, None
    return "free", None


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def entitlements(db: DbSession, user_id: uuid.UUID) -> dict[str, Any]:
    plan, _ = effective_plan(db, user_id)
    user = db.get(User, user_id)
    state = access(db, user) if user else {"state": "choose", "plan": "free"}
    return {
        "plan": plan,
        **limits_for(plan),
        "access": {k: _iso(v) for k, v in state.items()},
    }


def store_entitlements(db: DbSession, user_id: uuid.UUID) -> None:
    """Materialise the current limits (the `entitlements` table the spec names). A household of
    two is one plan (invariant 54): the partner's rows follow the holder's plan, so both are
    written whenever either's plan changes, and on joining or leaving."""
    for person in (user_id, *(u for u in household_pair(db, user_id) or () if u != user_id)):
        _store_one(db, person)
    db.flush()


def _store_one(db: DbSession, user_id: uuid.UUID) -> None:
    plan, sub = effective_plan(db, user_id)
    current = {
        e.key: e for e in db.scalars(select(Entitlement).where(Entitlement.user_id == user_id))
    }
    for key, value in {"plan": plan, **limits_for(plan)}.items():
        text = "unlimited" if value is None else str(value).lower()
        row = current.get(key)
        if row is None:
            db.add(
                Entitlement(
                    user_id=user_id, key=key, value=text, derived_from=sub.id if sub else None
                )
            )
        else:
            row.value = text
            row.derived_from = sub.id if sub else None


def require_feature(db: DbSession, user_id: uuid.UUID, key: str) -> None:
    if not entitlements(db, user_id).get(key):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_required")


def check_limit(db: DbSession, user_id: uuid.UUID, key: str, current_count: int) -> None:
    """403 plan_limit when adding one more would pass the plan's cap (null = unlimited)."""
    cap = entitlements(db, user_id).get(key)
    if cap is not None and current_count >= int(cap):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_limit")


def founding_taken(db: DbSession, *, exclude: str | None = None) -> int:
    """Founding places taken: every Founding purchase ever made counts, whatever its state now,
    so a place is never sold twice (owner decision, October 14, 2026). A bank payment still
    clearing holds its place; one that failed (`expired`) gives it back. The one count the
    pricing page, the Plan screen, checkout and the webhook all use (October 25, 2026)."""
    query = (
        select(func.count())
        .select_from(Subscription)
        .where(Subscription.plan == "founding", Subscription.status != "expired")
    )
    if exclude is not None:
        query = query.where(Subscription.external_id != exclude)
    return int(db.scalar(query) or 0)


def founding_left(db: DbSession) -> tuple[int, int]:
    """(cap, places left) for the Founding offer."""
    cap = int(load_plans()["founding"]["cap"])
    return cap, max(0, cap - founding_taken(db))
