"""Plan → limits (docs/spec.md "Plans & billing"): every number comes from plans.yaml.

The effective plan is the user's active subscription (Founding members get Connected's
limits). Downgrading never deletes: the app makes items over the limit read-only; the server
refuses only new things (creating a group, joining past the cap).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
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


# A purchase refused and refunded in full before it ever started: a second plan paid beside a
# live one (`refused`, October 29, 2026; invariant 41), or one paid with a card issued outside
# the US (`foreign_card`, October 30, 2026; invariant 75). Kept in `first_payment`.
FOREIGN_CARD = "foreign_card"
REFUSED = ("refused", FOREIGN_CARD)


def never_started(row: Subscription) -> bool:
    """A purchase whose money never arrived (a first bank debit that failed, or a Founding
    place given back, `expired`), or that was refunded in full when refused (`REFUSED`).
    It leaves the account where it was (October 28, 2026)."""
    return row.first_payment in ("failed", *REFUSED) or (
        row.plan == "founding" and row.status == "expired"
    )


def foreign_card_refused(db: DbSession, user_id: uuid.UUID, *, now: datetime | None = None) -> bool:
    """The person's latest web purchase, in the last two weeks, was refused because its card
    was issued outside the US (invariant 75): the Plan screen says why and asks for a US card.
    A later purchase, refused or not, takes its place."""
    since = (now or datetime.now(UTC)) - timedelta(days=14)
    latest = db.scalar(
        select(Subscription)
        .where(Subscription.user_id == user_id, Subscription.source == "stripe")
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    return (
        latest is not None and latest.first_payment == FOREIGN_CARD and latest.created_at >= since
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
    set not to renew; everything else waits until nothing else is live, and nothing is bought
    while a household's plan covers the person (`household_covered`)."""
    person = db.get(User, user_id)
    if person is not None and household_plan(db, person, exclude=exclude).covered:
        # One price covers both of a household (invariants 54, 70): a covered person never
        # pays a second time, whether at checkout or for a page paid after joining.
        return "household_covered"
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


def _formed_at(db: DbSession, pair: tuple[uuid.UUID, uuid.UUID]) -> datetime:
    """When the household became two: the later of the two members' joins."""
    joined = db.scalar(
        select(func.max(HouseholdMember.joined_at)).where(
            HouseholdMember.user_id.in_(pair), HouseholdMember.left_at.is_(None)
        )
    )
    assert joined is not None
    return joined


def _covers(state: dict[str, Any]) -> bool:
    """A live plan of the person's own that includes couples & household."""
    return state["state"] in LIVE_STATES and bool(limits_for(state["plan"])["household"])


def _holder(
    db: DbSession,
    pair: tuple[uuid.UUID, uuid.UUID],
    *,
    now: datetime,
    exclude: str | None = None,
) -> uuid.UUID | None:
    """Whose plan covers the household of two (owner decision, October 29, 2026: "partner and
    owner use the same account for one price"): one holder, always. A paid plan that includes
    household holds it, the owner's first; else the owner's trial that includes it (a partner's
    free trial never does); else nobody, and the plan has ended for both. The other is covered
    by it, even when they pay for a plan of their own too (they are told, and can stop theirs)."""
    owner_id, other_id = pair
    owner, other = db.get(User, owner_id), db.get(User, other_id)
    mine = _own_access(db, owner, now=now, exclude=exclude) if owner is not None else None
    theirs = _own_access(db, other, now=now, exclude=exclude) if other is not None else None
    if mine is not None and mine["state"] == "subscribed" and _covers(mine):
        return owner_id
    if theirs is not None and theirs["state"] == "subscribed" and _covers(theirs):
        return other_id
    if mine is not None and _covers(mine):
        return owner_id
    return None


def _household_end(
    db: DbSession, user: User, formed: datetime, now: datetime, *, owner: bool
) -> datetime | None:
    """The latest end, after the household became two, of a plan of this person's that held
    the household (a paid plan, a Founding term, a dispute lost, and the owner's trial: a
    partner's free trial never held it): the end of the plan the household shared, when it
    was theirs."""
    ends: list[datetime] = []
    if (
        owner
        and user.trial_plan
        and limits_for(user.trial_plan)["household"]
        and user.trial_ends_at is not None
        and formed < user.trial_ends_at <= now
    ):
        ends.append(user.trial_ends_at)
    for row in db.scalars(select(Subscription).where(Subscription.user_id == user.id)):
        if never_started(row) or not limits_for(row.plan)["household"]:
            continue
        end = row.ends_at or (row.updated_at if row.status in ("canceled", "expired") else None)
        for when in (end, row.dispute_lost_at):
            if when is not None and formed < when <= now:
                ends.append(when)
    return max(ends) if ends else None


def grace_end(ended: datetime) -> datetime:
    """When the 7 days after an end are over: 7 x 24 hours later, counted in UTC, whatever time
    zone the database session reads in, so a clock change never lengthens it (invariant 68)."""
    return ended.astimezone(UTC) + timedelta(days=int(trial_settings()["grace_days"]))


def _split_pause(db: DbSession, user: User) -> datetime | None:
    """The open dispute this person stays paused for after their household split during it."""
    if user.household_paused_by is None:
        return None
    row = db.get(Subscription, user.household_paused_by)
    if row is None or row.disputed_at is None or row.dispute_lost_at is not None:
        return None
    return row.disputed_at


def _household_dispute(db: DbSession, user_id: uuid.UUID, formed: datetime) -> datetime | None:
    found = _household_dispute_row(db, user_id, formed)
    return found.disputed_at if found is not None else None


def _household_dispute_row(
    db: DbSession, user_id: uuid.UUID, formed: datetime
) -> Subscription | None:
    """A payment for this person's plan that covered the household, disputed and still open:
    the household's plan is paused for both (invariant 54)."""
    for row in db.scalars(
        select(Subscription)
        .where(
            Subscription.user_id == user_id,
            Subscription.disputed_at.is_not(None),
            Subscription.dispute_lost_at.is_(None),
        )
        .order_by(Subscription.disputed_at.desc())
    ):
        if limits_for(row.plan)["household"] and (row.ends_at is None or row.ends_at > formed):
            return row
    return None


@dataclass(frozen=True)
class HouseholdPlan:
    """Where one person stands, a household of two counted as one plan: the one answer the
    app, the limits, checkout, the webhooks, plan changes, joining and leaving, deletion and the
    plan job all read (invariants 54, 67)."""

    access: dict[str, Any]
    # Whose plan applies to this person now: their own, the partner's that covers them, or
    # nobody's (no live plan).
    holder_id: uuid.UUID | None
    pair: tuple[uuid.UUID, uuid.UUID] | None

    @property
    def state(self) -> str:
        return str(self.access["state"])

    @property
    def plan(self) -> str:
        """The plan whose limits apply: the one shown, so the two never disagree."""
        return str(self.access["plan"]) if self.state in LIVE_STATES else "free"

    @property
    def covered(self) -> bool:
        """The partner's live plan covers this person: nothing to buy, no clock of their own."""
        return self.access.get("shared") == "covered" and self.state == "subscribed"

    @property
    def shared(self) -> bool:
        """The household's one plan is what this person is on: live, paused or ended for both,
        so its notices name the plan they share."""
        return "shared" in self.access


def household_plan(
    db: DbSession, user: User, *, now: datetime | None = None, exclude: str | None = None
) -> HouseholdPlan:
    """Where this account stands, a household of two counted as one plan (owner decision,
    October 29, 2026; invariants 54, 67). The one rule; nothing else decides it.

    - A paid plan of one's own that includes household is one's own (`shared: "holder"`), and
      so is the owner's trial that includes it.
    - One's own dispute (paused) or lost dispute (ended) is one's own.
    - Else, while the other's plan holds the household, one is `subscribed` to it,
      `shared: "covered"`: no trial clock, no card ask, no reminders, nothing to buy.
    - Else a live plan of one's own without household is one's own (no `shared`).
    - Else the household's plan is over: `paused` (`shared: "covered"`) while a payment for
      the plan that held it is disputed, never closed for it; else, when the other has no live
      plan either, `lapsed` from the end of that plan, the same day and the same 7 days for both
      (`shared: "holder"` for the person whose plan it was), unless an end of one's own came
      later (leaving, a holder switching down: `household_cover_ended_at`), which is then
      theirs alone.

    `exclude`: a purchase (its Stripe id) to leave out, to ask where the person stood beside it.
    """
    now = now or datetime.now(UTC)
    own = _own_access(db, user, now=now, exclude=exclude)
    live = own["state"] in LIVE_STATES
    pair = household_pair(db, user.id)
    if pair is None:
        if not live and (paused := _split_pause(db, user)) is not None:
            # The household split while its plan's payment was disputed: paused, never closed,
            # until the dispute closes (invariant 68).
            return HouseholdPlan(
                {"state": "paused", "plan": "free", "disputed_at": paused}, None, None
            )
        return HouseholdPlan(own, user.id if live else None, None)
    holder = _holder(db, pair, now=now, exclude=exclude)
    if holder == user.id:
        return HouseholdPlan({**own, "shared": "holder"}, user.id, pair)
    if own["state"] in ("paused", "ended"):
        return HouseholdPlan(own, None, pair)  # a dispute of their own is theirs alone
    if holder is not None:
        holder_user = db.get(User, holder)
        assert holder_user is not None
        plan = _own_access(db, holder_user, now=now)["plan"]
        return HouseholdPlan(
            {"state": "subscribed", "plan": plan, "shared": "covered"}, holder, pair
        )
    if live:
        return HouseholdPlan(own, user.id, pair)  # a plan of their own without household
    other_id = pair[1] if pair[0] == user.id else pair[0]
    other = db.get(User, other_id)
    assert other is not None
    formed = _formed_at(db, pair)
    disputed = _household_dispute(db, other_id, formed)
    if disputed is not None:
        state = {"state": "paused", "plan": "free", "disputed_at": disputed, "shared": "covered"}
        return HouseholdPlan(state, None, pair)
    if _own_access(db, other, now=now)["state"] in LIVE_STATES:
        return HouseholdPlan(own, None, pair)  # it didn't end for both: the other has a plan
    mine = _household_end(db, user, formed, now, owner=user.id == pair[0])
    theirs = _household_end(db, other, formed, now, owner=other_id == pair[0])
    ends = [e for e in (mine, theirs) if e is not None]
    if not ends:
        return HouseholdPlan(own, None, pair)  # never covered: their own state
    end = max(ends)
    if own["state"] == "lapsed" and own["ended_at"] > end:
        return HouseholdPlan(own, None, pair)  # an end of their own came later
    state = {
        "state": "lapsed",
        "plan": "free",
        "ended_at": end,
        "delete_at": grace_end(end),
        "shared": "holder" if mine == end else "covered",
    }
    return HouseholdPlan(state, None, pair)


def access(db: DbSession, user: User, *, now: datetime | None = None) -> dict[str, Any]:
    """Where this account stands (`household_plan`'s answer, as the app reads it)."""
    return household_plan(db, user, now=now).access


def covers_instead(db: DbSession, user: User, *, now: datetime | None = None) -> User | None:
    """The partner whose plan would cover this person if they had no plan of their own (the
    `household_plan` holder rule, read from the other's side), or None."""
    now = now or datetime.now(UTC)
    pair = household_pair(db, user.id)
    if pair is None:
        return None
    other_id = pair[1] if pair[0] == user.id else pair[0]
    other = db.get(User, other_id)
    if other is None:
        return None
    state = _own_access(db, other, now=now)
    if _covers(state) and (other_id == pair[0] or state["state"] == "subscribed"):
        return other
    return None


def covered_members(db: DbSession, user_id: uuid.UUID, *, now: datetime) -> list[User]:
    """Who in this person's household of two the shared plan covers right now (themselves
    included, when they are the one covered). Read before anything changes a plan or the
    household, then passed to `end_lost_cover`."""
    covered: list[User] = []
    for uid in household_pair(db, user_id) or ():
        person = db.get(User, uid)
        if person is None or person.deleted_at is not None:
            continue
        if household_plan(db, person, now=now).covered:
            covered.append(person)
    return covered


SplitStep = tuple[User, str, Any]


def household_split(db: DbSession, user_id: uuid.UUID, *, now: datetime) -> list[SplitStep]:
    """Read before a household of two splits (a leave, a deletion, a closing), and before
    anything ends a plan: what each member keeps once the pair is gone (invariants 54, 68).

    - covered by a live plan: their own 7 days start now (`household_cover_ended_at`);
    - lapsed with the household (its plan ended for both): they keep that same end and the same
      7 days, so they still close on schedule and never get a fresh start;
    - paused with the household (its plan's payment disputed): they stay paused for that
      dispute (`household_paused_by`) until it closes, then their own 7 days start.
    Applied by `apply_household_split` once the membership has changed."""
    steps: list[SplitStep] = []
    pair = household_pair(db, user_id)
    for uid in pair or ():
        person = db.get(User, uid)
        if person is None or person.deleted_at is not None:
            continue
        found = household_plan(db, person, now=now)
        if found.covered:
            steps.append((person, "cover_ended", now))
        elif found.shared and found.state == "lapsed":
            steps.append((person, "cover_ended", found.access["ended_at"]))
        elif found.shared and found.state == "paused" and pair is not None:
            other = pair[1] if pair[0] == uid else pair[0]
            row = _household_dispute_row(db, other, _formed_at(db, pair))
            if row is not None:
                steps.append((person, "paused_by", row.id))
    return steps


def leave_outcome(db: DbSession, user: User, *, now: datetime) -> dict[str, Any]:
    """What this member keeps if the household splits now (the Leave sheet, invariant 67), from
    the same rule as `household_split`: `keeps` (the plan they hold), `own_plan` (back to a
    plan of their own), `seven_days` (until `until`), `same_end` (already lapsed with the
    household: the same date), `paused` (until the dispute closes), `unchanged`."""
    found = household_plan(db, user, now=now)
    if found.holder_id == user.id and found.shared:
        return {"outcome": "keeps", "plan": found.plan, "until": None}
    if found.covered:
        own = _own_access(db, user, now=now)
        if own["state"] in LIVE_STATES:
            return {"outcome": "own_plan", "plan": own["plan"], "until": None}
        return {"outcome": "seven_days", "plan": None, "until": grace_end(now)}
    if found.shared and found.state == "lapsed":
        return {"outcome": "same_end", "plan": None, "until": found.access["delete_at"]}
    if found.shared and found.state == "paused":
        return {"outcome": "paused", "plan": None, "until": None}
    return {"outcome": "unchanged", "plan": None, "until": None}


def apply_household_split(db: DbSession, steps: list[SplitStep]) -> None:
    for person, kind, value in steps:
        if kind == "cover_ended":
            later = person.household_cover_ended_at
            if later is None or later < value:
                person.household_cover_ended_at = value
        else:
            person.household_paused_by = value
    db.flush()


def release_split_pauses(
    db: DbSession, subscription_ids: list[uuid.UUID], *, now: datetime
) -> None:
    """A dispute closed (won or lost): whoever stayed paused for it after their household split
    is on their own from now, with their own 7 days (invariant 68)."""
    if not subscription_ids:
        return
    for person in db.scalars(select(User).where(User.household_paused_by.in_(subscription_ids))):
        person.household_paused_by = None
        person.household_cover_ended_at = now
    db.flush()


def end_lost_cover(db: DbSession, before: list[User], *, now: datetime) -> list[User]:
    """After a change (leaving, deleting, the holder switching to a plan without household):
    whoever the shared plan covered before and is now on their own, while that plan carries on
    for its holder, starts their own 7 days now (`household_cover_ended_at`), with the plan job's
    "no longer covers you" email, and never a fresh trial (invariants 54, 69). A plan that
    ended, or is paused, for both is the household's end, not this."""
    db.flush()
    stamped: list[User] = []
    for person in before:
        if household_plan(db, person, now=now).shared:
            continue  # still covered, or the household's plan ended or paused for both
        person.household_cover_ended_at = now
        stamped.append(person)
    db.flush()
    return stamped


def _own_access(
    db: DbSession, user: User, *, now: datetime | None = None, exclude: str | None = None
) -> dict[str, Any]:
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
    sub = active_subscription(db, user.id, now=now, exclude=exclude)
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
        "delete_at": grace_end(ended),
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
    """The plan whose limits apply, with the person's own live subscription (if any): what
    `household_plan` says, so the limits always agree with what the person is shown
    (invariant 67): a household's shared plan covers a person even beside a plan of their own
    without household, and an admin's tester plan counts.

    `tester=False` is billing's question instead: the person's own real subscription (or own
    trial), leaving out the tester plan and the household's cover, because checkout, change,
    cancel and the portal act on what the person pays for themselves."""
    sub = active_subscription(db, user_id)
    user = db.get(User, user_id)
    if user is None:
        return "free", None
    if not tester:
        if sub is not None:
            return sub.plan, sub
        now = datetime.now(UTC)
        if user.trial_plan and user.trial_ends_at and user.trial_ends_at > now:
            return user.trial_plan, None
        return "free", None
    return household_plan(db, user).plan, sub


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def entitlements(db: DbSession, user_id: uuid.UUID) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        return {"plan": "free", **limits_for("free"), "access": {"state": "choose", "plan": "free"}}
    found = household_plan(db, user)
    return {
        "plan": found.plan,
        **limits_for(found.plan),
        "access": {k: _iso(v) for k, v in found.access.items()},
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
