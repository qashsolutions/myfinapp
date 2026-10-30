"""Every way a household's plan can stand, for both people (October 29, 2026; invariants 54,
67-70).

Asha owns the household, Ben joined it 30 days ago. The plan that covers them is held by
Asha (`owner`) or by Ben (`partner`), and that plan is in one of the states below. For both
people each case says, worked out by hand from the rule (docs/spec.md "Couples & household",
"One plan for two"), never from the code:

- where they stand (state, the plan shown, holder / covered / their own),
- that the limits applied are the plan shown (live) or Free (not live),
- the notices the hourly plan job sends now, and that a second run sends none again,
- who is closed when the 7 days are over, and that nobody is closed without the ended email
  and nobody is closed while a dispute is open.

How the cases are set up:
- holder `owner`: Asha's own Connected trial started the household and ended 25 days ago;
  her plan (below) is what holds it now. Ben has nothing of his own.
- holder `partner`: Asha's trial started it and ended 6 days ago, and Ben's plan (below) is
  the one he took in her 7 days. A partner's free trial never holds a household; a paid plan
  of his does, from the day he subscribes.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import Subscription
from app.models.user import User
from app.rules_server.entitlements import limits_for
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import PLACEHOLDER_CONSENT, grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing_change import FakeStripe as ChangeStripe
from tests.test_billing_change import change
from tests.test_household_one_plan import household, is_deleted, person, run, set_user

BLOB = {"ciphertext": "ZGF0YQ", "version": 1}
CLOSED = "Your Qash account has closed"
ENDED_SUBJECTS = (
    "has wrapped up",
    "has ended",
    "no longer covers you",
)


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


@dataclass(frozen=True)
class Who:
    state: str
    plan: str  # the plan shown in `access`
    shared: str | None  # "holder", "covered", or None (their own)


@dataclass(frozen=True)
class Case:
    holder: str  # "owner" (Asha) or "partner" (Ben)
    plan_state: str
    holder_is: Who
    other_is: Who
    # The subjects each sends now, as prefixes: (holder's, other's).
    notices: tuple[tuple[str, ...], tuple[str, ...]] = ((), ())
    # Who is closed once the 7 days are over: of "holder", "other".
    closed: frozenset[str] = field(default_factory=frozenset)
    same_delete_at: bool = False  # both lapsed on the same day, with the same 7 days


H, C = "holder", "covered"
CONN = "connected"
SHARED_PLAN_ENDED = "Your shared Qash plan has wrapped up"
SHARED_TRIAL_ENDED = "Your shared Qash trial has wrapped up"
SHARED_PLAN_ENDING = "Your shared Qash plan wraps up on"
SHARED_TRIAL_ENDING = "Your shared free trial wraps up on"
FOUNDING_ENDED = "Your household's Founding membership has ended"
NO_LONGER = "Your household's plan no longer covers you"
# The holder lost a dispute: the plan that covered the other ended, nothing about why.
COVER_PLAN_ENDED = "The plan that covered you has ended"
REMINDER = "A friendly reminder: 4 days left"
BOTH = frozenset({"holder", "other"})

# Live plans the holder pays for: the other is covered, nobody hears anything, nobody closes.
_PAID_LIVE = ("card_trial", "monthly", "yearly", "past_due", "dispute_won")


def _live(holder: str, state: str, plan: str = CONN) -> Case:
    return Case(holder, state, Who("subscribed", plan, H), Who("subscribed", plan, C))


CASES: list[Case] = [
    # --- Asha holds the household's plan --------------------------------------------------
    Case(
        "owner",
        "trial",  # her free trial ends in 20 hours: both hear it, once
        Who("trial", CONN, H),
        Who("subscribed", CONN, C),
        notices=((SHARED_TRIAL_ENDING,), (SHARED_TRIAL_ENDING,)),
    ),
    *(_live("owner", s) for s in _PAID_LIVE),
    Case(
        "owner",
        "cancelled_running",  # set not to renew, 12 hours left
        Who("subscribed", CONN, H),
        Who("subscribed", CONN, C),
        notices=((SHARED_PLAN_ENDING,), (SHARED_PLAN_ENDING,)),
    ),
    Case(
        "owner",
        "cancelled_ended",  # ended an hour ago: the same end and 7 days for both
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((SHARED_PLAN_ENDED,), (SHARED_PLAN_ENDED,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    _live("owner", "founding_active", "founding"),
    Case(
        "owner",
        "founding_ended",
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((FOUNDING_ENDED,), (FOUNDING_ENDED,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    Case(
        "owner",
        "disputed",  # paused for both, never closed
        Who("paused", "free", None),
        Who("paused", "free", C),
    ),
    Case(
        "owner",
        "dispute_lost",  # her plan ended, her account stays open; Ben has the 7 days
        Who("ended", "free", None),
        Who("lapsed", "free", C),
        notices=((), (COVER_PLAN_ENDED,)),
        closed=frozenset({"other"}),
    ),
    Case(
        "owner",
        "switched_down",  # to Private: her plan carries on, Ben's own 7 days start now
        Who("subscribed", "private", None),
        Who("lapsed", "free", None),
        notices=((), (NO_LONGER,)),
        closed=frozenset({"other"}),
    ),
    Case(
        "owner",
        "lapsed",  # ended 3 days ago, told then; today's reminder, then both close
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((REMINDER,), (REMINDER,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    Case(
        "owner",
        "payment_failed",  # her first bank payment failed; her trial still holds
        Who("trial", CONN, H),
        Who("subscribed", CONN, C),
    ),
    # --- Ben holds the household's plan ---------------------------------------------------
    Case(
        "partner",
        "trial",  # his free trial never held it: Asha's own 7 days from her trial end run out
        Who("trial", CONN, None),
        Who("lapsed", "free", None),  # not "shared": it hasn't ended for him
        notices=(("Your free trial wraps up on",), ("Your Qash trial has wrapped up",)),
        closed=frozenset({"other"}),
    ),
    *(_live("partner", s) for s in _PAID_LIVE),
    Case(
        "partner",
        "cancelled_running",
        Who("subscribed", CONN, H),
        Who("subscribed", CONN, C),
        notices=((SHARED_PLAN_ENDING,), (SHARED_PLAN_ENDING,)),
    ),
    Case(
        "partner",
        "cancelled_ended",  # finding 1: Asha gets Ben's plan's end, the email and 7 days
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((SHARED_PLAN_ENDED,), (SHARED_PLAN_ENDED,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    _live("partner", "founding_active", "founding"),
    Case(
        "partner",
        "founding_ended",
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((FOUNDING_ENDED,), (FOUNDING_ENDED,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    Case(
        "partner",
        "disputed",  # finding 1: Asha is paused with him, never closed
        Who("paused", "free", None),
        Who("paused", "free", C),
    ),
    Case(
        "partner",
        "dispute_lost",
        Who("ended", "free", None),
        Who("lapsed", "free", C),
        notices=((), (COVER_PLAN_ENDED,)),
        closed=frozenset({"other"}),
    ),
    Case(
        "partner",
        "switched_down",  # finding 5, from the partner's side
        Who("subscribed", "private", None),
        Who("lapsed", "free", None),
        notices=((), (NO_LONGER,)),
        closed=frozenset({"other"}),
    ),
    Case(
        "partner",
        "lapsed",
        Who("lapsed", "free", H),
        Who("lapsed", "free", C),
        notices=((REMINDER,), (REMINDER,)),
        closed=BOTH,
        same_delete_at=True,
    ),
    Case(
        "partner",
        "payment_failed",  # his first payment never came: Asha's trial end is the household's
        Who("lapsed", "free", C),
        Who("lapsed", "free", H),
        notices=((SHARED_TRIAL_ENDED,), (SHARED_TRIAL_ENDED,)),
        closed=BOTH,
        same_delete_at=True,
    ),
]


def _subs(user_id: uuid.UUID, **fields) -> None:
    with get_session_factory()() as db:
        for sub in db.scalars(select(Subscription).where(Subscription.user_id == user_id)):
            for k, v in fields.items():
                setattr(sub, k, v)
        db.commit()


def _grant(user_id: uuid.UUID, plan: str = CONN, interval: str = "yearly", **fields) -> None:
    grant_plan(str(user_id), plan, interval=interval)
    if fields:
        _subs(user_id, **fields)


def _build(case: Case, now: datetime, client, user_id: uuid.UUID, is_owner: bool) -> None:
    """Put the holder's plan in `case.plan_state`, as of `now`."""
    hour = timedelta(hours=1)
    match case.plan_state:
        case "trial":
            set_user(user_id, trial_plan=CONN, trial_ends_at=now + timedelta(hours=20))
        case "card_trial":  # a card given in the trial: Stripe bills when it ends
            _grant(user_id, interval="monthly")
            set_user(user_id, trial_plan=CONN, trial_ends_at=now + timedelta(days=2))
        case "monthly":
            _grant(user_id, interval="monthly")
        case "yearly":
            _grant(user_id)
        case "past_due":
            _grant(user_id, status="past_due")
        case "dispute_won":
            _grant(user_id, disputed_at=now - hour)
            _subs(user_id, disputed_at=None)
        case "cancelled_running":
            _grant(user_id, cancel_at_period_end=True, renews_at=now + timedelta(hours=12))
        case "cancelled_ended":
            _grant(user_id, status="canceled", stripe_status="canceled", ends_at=now - hour)
        case "founding_active":
            _grant(user_id, "founding")
        case "founding_ended":
            _grant(user_id, "founding", ends_at=now - hour)
        case "disputed":
            _grant(user_id, disputed_at=now)
        case "dispute_lost":
            _grant(
                user_id,
                status="canceled",
                stripe_status="canceled",
                ends_at=now - hour,
                disputed_at=now - 2 * hour,
                dispute_lost_at=now - hour,
            )
        case "lapsed":
            _grant(user_id, status="canceled", stripe_status="canceled", ends_at=now - timedelta(3))
        case "payment_failed":
            if is_owner:  # her trial is still on
                set_user(user_id, trial_ends_at=now + timedelta(days=2))
            _grant(user_id, status="canceled", stripe_status="canceled", first_payment="failed")
        case "switched_down":
            _grant(user_id, created_at=now - timedelta(days=40))
            fake = ChangeStripe("price_connected_y")
            fake.due, fake.total = 0, -7199
            stripe_billing.transport_override = fake.transport()
            r = change(client, "private", "yearly")
            assert r.status_code == 200, r.text
            stripe_billing.transport_override = stripe_default_transport()
        case other:
            raise AssertionError(other)


def _access(client) -> dict:
    return client.get("/api/billing/entitlements").json()


def _check(client, who: Who) -> dict:
    got = _access(client)
    access = got["access"]
    assert (access["state"], access["plan"], access.get("shared")) == (
        who.state,
        who.plan,
        who.shared,
    ), access
    # The limits applied are the plan shown while it is live, else Free (invariant 67).
    applies = who.plan if who.state in ("subscribed", "trial") else "free"
    assert got["plan"] == applies
    assert {k: got[k] for k in limits_for(applies)} == limits_for(applies)
    return access


def _subjects(email: str) -> list[str]:
    return [m.subject for m in outbox() if m.to == email]


def _sent(email: str, start: int) -> list[str]:
    return _subjects(email)[start:]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c.holder}-{c.plan_state}")
def test_both_people_in_every_plan_state(case: Case) -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": CONN}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)  # formed 30 days ago
    set_user(asha_id, trial_ends_at=now - timedelta(days=25 if case.holder == "owner" else 6))
    if case.holder == "owner":
        hc, hid, hmail, oc, oid, omail = asha, asha_id, asha_email, ben, ben_id, ben_email
    else:
        hc, hid, hmail, oc, oid, omail = ben, ben_id, ben_email, asha, asha_id, asha_email
    _build(case, now, hc, hid, case.holder == "owner")
    if case.plan_state == "lapsed":
        run(now - timedelta(days=3) + timedelta(hours=1), asha_id, ben_id)  # told the day it ended

    h = _check(hc, case.holder_is)
    o = _check(oc, case.other_is)
    if case.same_delete_at:
        assert h["delete_at"] == o["delete_at"] and h["ended_at"] == o["ended_at"]

    # The notices due now, each once.
    before = {hmail: len(_subjects(hmail)), omail: len(_subjects(omail))}
    run(datetime.now(UTC), asha_id, ben_id)  # now: after the case was set up
    for email, expected in ((hmail, case.notices[0]), (omail, case.notices[1])):
        sent = _sent(email, before[email])
        sent = [s for s in sent if s != "Your plan changed"]
        assert len(sent) == len(expected), (email, sent)
        assert all(s.startswith(e) for s, e in zip(sent, expected, strict=True)), sent
    counted = {e: len(_subjects(e)) for e in (hmail, omail)}
    run(datetime.now(UTC), asha_id, ben_id)  # now: after the case was set up
    assert {e: len(_subjects(e)) for e in (hmail, omail)} == counted  # never twice

    # Once the 7 days are over (and long after, for a dispute): who is closed.
    later = now + (timedelta(days=30) if "disput" in case.plan_state else timedelta(7, 7200))
    run(later, asha_id, ben_id)
    run(later, asha_id, ben_id)
    closed = {r for r, uid in (("holder", hid), ("other", oid)) if is_deleted(uid)}
    assert closed == set(case.closed)
    for role, email in (("holder", hmail), ("other", omail)):
        subjects = _subjects(email)
        if role in closed:
            # Never closed without the ended email for it, sent before the closing one.
            at = subjects.index(CLOSED)
            assert any(e in s for s in subjects[:at] for e in ENDED_SUBJECTS), subjects
        else:
            assert CLOSED not in subjects


def test_the_covered_person_who_also_pays_for_private_is_on_the_households_plan() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), CONN)
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "private")
    _check(ben, Who("subscribed", CONN, C))
    _check(asha, Who("subscribed", CONN, H))
    assert ben.put("/api/household/blobs/jars", json=BLOB).status_code == 200
    r = ben.post(
        "/api/billing/checkout",
        json={"plan": CONN, "interval": "monthly", "consent": PLACEHOLDER_CONSENT},
    )
    assert r.status_code in (409, 503), r.text
    if r.status_code == 409:
        assert r.json()["detail"] == "household_covered"
    # He leaves: his own Private plan is what he has, with nothing lost.
    assert ben.post("/api/household/leave").status_code == 204
    _check(ben, Who("subscribed", "private", None))


def test_the_owner_paying_private_beside_a_partner_paying_connected() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), CONN)
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), CONN)
    _subs(asha_id, plan="private")
    _check(asha, Who("subscribed", CONN, C))
    _check(ben, Who("subscribed", CONN, H))
    for client in (asha, ben):
        assert client.put("/api/household/blobs/jars", json=BLOB).status_code == 200
    # Ben's plan ends: Asha's own Private carries on for her, and nothing closes her.
    _subs(ben_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(hours=1))
    _check(asha, Who("subscribed", "private", None))
    _check(ben, Who("lapsed", "free", None))
    run(datetime.now(UTC) + timedelta(days=8), asha_id, ben_id)
    assert not is_deleted(asha_id)
    with get_session_factory()() as db:
        assert db.get(User, asha_id) is not None


def test_a_covered_person_whose_own_plan_ran_out_stays_covered() -> None:
    """Stopping one's own plan after joining (owner decision, October 29, 2026): when its paid
    period ends nothing changes for the covered person, and nothing is sent or closed."""
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), CONN)
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "private", interval="monthly")
    _subs(ben_id, cancel_at_period_end=True, renews_at=datetime.now(UTC) + timedelta(hours=12))
    _check(ben, Who("subscribed", CONN, C))
    _subs(ben_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(hours=1))
    _check(ben, Who("subscribed", CONN, C))
    _check(asha, Who("subscribed", CONN, H))
    before = len(_subjects(ben_email))
    run(datetime.now(UTC), asha_id, ben_id)
    run(datetime.now(UTC) + timedelta(days=8), asha_id, ben_id)
    assert len(_subjects(ben_email)) == before and not is_deleted(ben_id)


# --- The household splits (review of #57, October 29, 2026; invariant 68) ----------------------


def _household_for(holder: str, plan_state: str):
    """The same set-up as the matrix: (holder client, id, email, other client, id, email)."""
    now = datetime.now(UTC)
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": CONN}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_user(asha_id, trial_ends_at=now - timedelta(days=25 if holder == "owner" else 6))
    if holder == "owner":
        found = (asha, asha_id, asha_email, ben, ben_id, ben_email)
    else:
        found = (ben, ben_id, ben_email, asha, asha_id, asha_email)
    case = Case(holder, plan_state, Who("", "", None), Who("", "", None))
    _build(case, now, found[0], found[1], holder == "owner")
    return found


def _split(how: str, hc, oc) -> None:
    if how == "holder_deletes":
        r = hc.post("/api/account/delete", json={"confirm": "DELETE"})
        assert r.status_code == 204, r.text
    elif how == "holder_leaves":
        assert hc.post("/api/household/leave").status_code == 204
    else:
        assert oc.post("/api/household/leave").status_code == 204


@pytest.mark.parametrize("how", ["holder_deletes", "holder_leaves", "other_leaves"])
@pytest.mark.parametrize("holder", ["owner", "partner"])
def test_a_split_in_the_seven_days_keeps_the_households_end_for_whoever_stays(
    holder: str, how: str
) -> None:
    """The plan ended for both an hour ago; one leaves or closes their account: whoever is left
    keeps that same end and the same 7 days, can't start a trial, and closes on schedule."""
    hc, hid, hmail, oc, oid, omail = _household_for(holder, "cancelled_ended")
    before = _check(oc, Who("lapsed", "free", C))
    _split(how, hc, oc)
    people = [(oc, oid, omail)] + ([] if how == "holder_deletes" else [(hc, hid, hmail)])
    for client, _, _ in people:
        state = _access(client)["access"]
        assert state["state"] == "lapsed", state
        assert state["delete_at"] == before["delete_at"]
        assert client.post("/api/billing/trial", json={"plan": CONN}).status_code == 409
    run(datetime.now(UTC), hid, oid)
    end = datetime.fromisoformat(before["delete_at"])
    run(end + timedelta(hours=1), hid, oid)
    run(end + timedelta(hours=2), hid, oid)
    for _, uid, email in people:
        assert is_deleted(uid)
        subjects = _subjects(email)
        at = subjects.index(CLOSED)
        assert any(e in s for s in subjects[:at] for e in ENDED_SUBJECTS), subjects


@pytest.mark.parametrize("how", ["holder_deletes", "holder_leaves", "other_leaves"])
@pytest.mark.parametrize("holder", ["owner", "partner"])
def test_a_split_during_a_dispute_leaves_the_other_paused_and_never_closed(
    holder: str, how: str
) -> None:
    hc, hid, _, oc, oid, _ = _household_for(holder, "disputed")
    _check(oc, Who("paused", "free", C))
    _split(how, hc, oc)
    assert _access(oc)["access"]["state"] == "paused"
    assert oc.post("/api/billing/trial", json={"plan": CONN}).status_code == 409
    run(datetime.now(UTC) + timedelta(days=30), hid, oid)
    assert not is_deleted(oid)


@pytest.mark.parametrize("holder", ["owner", "partner"])
def test_one_closing_alone_leaves_the_other_on_the_households_end(holder: str) -> None:
    """The plan job closes the one who was told; the other, not told yet, isn't closed with
    them, keeps the same end, hears of it, then closes."""
    _, hid, _, oc, oid, omail = _household_for(holder, "cancelled_ended")
    before = _check(oc, Who("lapsed", "free", C))
    run(datetime.now(UTC), hid)  # only the holder is told
    end = datetime.fromisoformat(before["delete_at"])
    run(end + timedelta(hours=1), hid)
    assert is_deleted(hid) and not is_deleted(oid)
    state = _access(oc)["access"]
    assert state["state"] == "lapsed" and state["delete_at"] == before["delete_at"]
    run(end + timedelta(hours=2), oid)
    assert not is_deleted(oid)  # told first
    run(end + timedelta(hours=3), oid)
    assert is_deleted(oid)
    subjects = _subjects(omail)
    assert any(e in s for s in subjects[: subjects.index(CLOSED)] for e in ENDED_SUBJECTS)
