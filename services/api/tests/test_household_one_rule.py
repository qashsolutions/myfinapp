"""A household's plan is decided by one rule (October 29, 2026; invariants 54, 67-70).

The owner's test of PR #53 found four gaps, each because a path decided the household's plan
on its own instead of asking `entitlements.household_plan`:

1. The household's owner, covered by the partner's plan, was given their own old state back
   when that plan ended or was disputed: closed by the next hourly run with no ended email and
   no 7 days, and never shown "paused" during a dispute.
4. The limits applied (`effective_plan`) used the person's own subscription before the
   household's cover, so a covered person who also paid for Private got Private's limits, and
   an owner paying Private beside a partner paying Connected was refused shared jar writes.
5. Switching down to a plan without household dropped the partner silently: no notice, no 7
   days, and a fresh trial on offer.
6. A household could pay twice: a page opened before joining, paid after it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.billing import CheckoutPage, Subscription
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import buy, post_event
from tests.test_billing_change import FakeStripe as ChangeStripe
from tests.test_billing_change import change, started_days_ago
from tests.test_billing_oct29 import Stripe, _checkout, _event, _row
from tests.test_household_one_plan import (
    access,
    household,
    is_deleted,
    mail,
    person,
    run,
    set_subscription,
    set_user,
)

BLOB = {"ciphertext": "ZGF0YQ", "version": 1}


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


def _partner_holds(now: datetime):
    """Asha (the owner) started the household on a trial that ended 20 days ago; Ben, her
    partner, subscribed to Connected within its 7 days, so his plan covers them both."""
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_user(asha_id, trial_ends_at=now - timedelta(days=20))
    grant_plan(str(ben_id), "connected")
    assert access(asha) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    return asha, asha_id, asha_email, ben, ben_id, ben_email


# --- 1. The owner covered by the partner -------------------------------------------------------


def test_the_owner_covered_by_the_partners_plan_gets_its_end_the_email_and_seven_days() -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email, ben, ben_id, ben_email = _partner_holds(now)
    ended = now - timedelta(hours=1)
    set_subscription(ben_id, status="canceled", ends_at=ended)
    a, b = access(asha), access(ben)
    assert a["state"] == b["state"] == "lapsed"
    assert a["delete_at"] == b["delete_at"]  # the same 7 days, from Ben's plan's end
    assert datetime.fromisoformat(a["ended_at"]) == ended
    assert run(now, asha_id, ben_id) == {"ending_soon": 0, "ended": 2, "reminded": 0, "deleted": 0}
    assert not is_deleted(asha_id)
    assert mail(asha_email)[-1] == mail(ben_email)[-1] == "Your shared Qash plan has wrapped up"
    assert run(now + timedelta(days=7, hours=2), asha_id)["deleted"] == 2


def test_the_owner_covered_by_the_partners_disputed_plan_is_paused_and_never_closed() -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email, ben, ben_id, _ = _partner_holds(now)
    set_subscription(ben_id, disputed_at=now)
    assert access(ben)["state"] == "paused"
    assert access(asha)["state"] == "paused" and access(asha)["shared"] == "covered"
    assert run(now + timedelta(days=30), asha_id, ben_id)["deleted"] == 0
    assert not is_deleted(asha_id)
    with get_session_factory()() as db:
        stripe_billing._tell_covered_partner(db, ben_id, "disputed")
    assert mail(asha_email)[-1] == "Your household's Qash plan is paused"


# --- 4. One plan applies, the one shown --------------------------------------------------------


def test_a_covered_person_paying_private_gets_the_households_limits() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "private")
    got = ben.get("/api/billing/entitlements").json()
    assert got["access"]["shared"] == "covered" and got["access"]["plan"] == "connected"
    assert got["plan"] == "connected" and got["bank_links_max"] == 3 and got["household"] is True


def test_an_owner_paying_private_beside_a_partner_paying_connected_shares_jars() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "connected")
    set_subscription(asha_id, plan="private")  # Asha switched down; Ben's plan holds
    got = asha.get("/api/billing/entitlements").json()
    assert got["access"] == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert got["plan"] == "connected"
    assert asha.put("/api/household/blobs/jars", json=BLOB).status_code == 200
    assert ben.put("/api/household/blobs/jars", json=BLOB).status_code == 200


# --- 5. Switching down ends the cover, with notice ---------------------------------------------


def test_switching_down_gives_the_partner_the_email_and_seven_days_and_no_new_trial() -> None:
    asha, asha_id, asha_email = person("Asha")
    grant_plan(str(asha_id), "connected", interval="yearly")
    started_days_ago(str(asha_id), 40)
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    fake = ChangeStripe("price_connected_y")
    fake.due, fake.total = 0, -7199
    stripe_billing.transport_override = fake.transport()
    preview = asha.post(
        "/api/billing/change/preview", json={"plan": "private", "interval": "yearly"}
    ).json()
    # The holder is told first, in the sheet, what it means for Ben.
    assert any("Ben" in p and "7 days" in p for p in preview["consent"]["lines"]), preview
    r = change(asha, "private", "yearly", proration_date=preview["proration_date"])
    assert r.status_code == 200, r.text
    state = access(ben)
    assert state["state"] == "lapsed", state
    started = datetime.fromisoformat(state["ended_at"])
    assert abs((datetime.now(UTC) - started).total_seconds()) < 60
    assert datetime.fromisoformat(state["delete_at"]) - started == timedelta(days=7)
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 409
    assert access(asha) == {"state": "subscribed", "plan": "private"}
    assert run(datetime.now(UTC), asha_id, ben_id)["ended"] == 1
    assert mail(ben_email)[-1] == "Your household's plan no longer covers you"
    assert run(datetime.now(UTC), asha_id, ben_id)["ended"] == 0  # once
    assert not any("wrapped up" in s for s in mail(asha_email))


# --- 6. Never paid twice -----------------------------------------------------------------------


def test_joining_a_household_closes_the_joiners_open_payment_pages() -> None:
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    r = ben.post("/api/billing/checkout", json=buy(ben, plan="connected", interval="yearly"))
    assert r.status_code == 200, r.text
    stripe.expire_status = 200  # still open at Stripe
    household(asha, ben)
    expired = [p for m, p, _ in stripe.calls if p.endswith("/expire")]
    assert expired == ["/v1/checkout/sessions/cs_1/expire"]
    with get_session_factory()() as db:
        pages = db.scalars(select(CheckoutPage).where(CheckoutPage.user_id == ben_id)).all()
        assert pages and all(p.expires_at <= datetime.now(UTC) for p in pages)


def test_a_page_paid_after_joining_a_household_is_ended_and_refunded_once() -> None:
    """The page was already being paid as he joined: the household's plan covers him, so this
    second plan is ended at Stripe and refunded in full, once, with the plain email."""
    stripe = Stripe()
    stripe_billing.transport_override = stripe.transport()
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    stripe.subscription("sub_b_twice", str(ben_id), "connected", "yearly")
    stripe.paid("sub_b_twice", 6500)
    outbox().clear()
    done = _checkout("sub_b_twice", str(ben_id), "connected", "yearly")
    outcome = post_event(ben, _event("checkout.session.completed", done)).json()["outcome"]
    assert outcome == "second_plan"
    assert stripe.deleted() == ["sub_b_twice"]
    assert len(stripe.refunds) == 1
    assert _row("sub_b_twice").first_payment == "refused"
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert mail(ben_email) == ["We refunded a second Qash plan"]
    post_event(ben, _event("checkout.session.completed", done))
    assert len(stripe.refunds) == 1 and len(mail(ben_email)) == 1


# --- Owner decisions on #57's doubts (October 29, 2026) ----------------------------------------


def test_after_the_holder_loses_a_dispute_the_partner_hears_only_that_the_plan_ended() -> None:
    now = datetime.now(UTC)
    asha, asha_id, asha_email = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_subscription(
        asha_id,
        status="canceled",
        stripe_status="canceled",
        ends_at=now - timedelta(hours=1),
        disputed_at=now - timedelta(hours=2),
        dispute_lost_at=now - timedelta(hours=1),
    )
    run(datetime.now(UTC), asha_id, ben_id)
    note = next(m for m in reversed(outbox()) if m.to == ben_email)
    assert note.subject == "The plan that covered you has ended"
    assert "within 7 days" in note.text and "Download all my data" in note.text
    assert "disput" not in note.text.lower() and "disput" not in note.subject.lower()
    assert "both of you" not in note.text
    reminded = run(datetime.now(UTC) + timedelta(days=2), asha_id, ben_id)
    assert reminded["reminded"] == 1  # Ben only: Asha's account is ended, not lapsed
    text = next(m for m in reversed(outbox()) if m.to == ben_email).text
    assert "goes to both of you" not in text and "disput" not in text.lower()
    assert not any("plan" in s.lower() for s in mail(asha_email))  # nothing for Asha here


def _join_preview(owner, joiner) -> dict:
    code = owner.post("/api/household/invites").json()["code"]
    r = joiner.post("/api/household/lookup", json={"code": code})
    assert r.status_code == 200, r.text
    return r.json()


def test_the_invite_says_when_the_joiner_pays_for_a_plan_of_their_own() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    assert _join_preview(asha, ben)["you_pay"] is None  # nothing of his own
    grant_plan(str(ben_id), "private", interval="monthly")
    you_pay = _join_preview(asha, ben)["you_pay"]
    assert you_pay["plan"] == "private" and you_pay["label"] == "Private"
    assert you_pay["source"] == "stripe" and you_pay["renews_at"]
    set_subscription(ben_id, source="apple")
    assert _join_preview(asha, ben)["you_pay"]["source"] == "apple"
    set_subscription(ben_id, source="stripe", cancel_at_period_end=True)
    assert _join_preview(asha, ben)["you_pay"] is None  # already stopping: nothing to ask
    set_subscription(ben_id, cancel_at_period_end=False)
    # Looking and joining never stop anything by themselves.
    household(asha, ben)
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == ben_id))
        assert row is not None and row.status == "active" and not row.cancel_at_period_end


def test_a_covered_person_stops_their_own_plan_and_stays_covered() -> None:
    from tests.billing_helpers import cancel_consent  # noqa: PLC0415
    from tests.test_billing_cancel import FakeStripe as CancelStripe  # noqa: PLC0415

    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    grant_plan(str(ben_id), "private", interval="monthly")
    billing = ben.get("/api/billing").json()
    assert billing["shared"] == "covered" and billing["own_plan"] == "private"
    assert billing["renews_at"]
    assert asha.get("/api/billing").json()["own_plan"] is None
    stripe_billing.transport_override = CancelStripe().transport()
    consent = cancel_consent(ben)
    assert any("Asha's plan covers you" in line for line in consent["lines"]), consent
    assert not any("deleted" in line.lower() for line in consent["lines"])
    r = ben.post("/api/billing/cancel", json={"consent": consent})
    assert r.status_code == 200, r.text
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    # His own plan's paid period ends: still covered, no ended notes, never closed.
    now = datetime.now(UTC)
    set_subscription(ben_id, status="canceled", ends_at=now - timedelta(hours=1))
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    before = len(mail(ben_email))
    run(now + timedelta(days=8), asha_id, ben_id)
    assert len(mail(ben_email)) == before and not is_deleted(ben_id)


# --- Review of #57 (October 29, 2026): D1, D2, L5, L6 --------------------------------------------


def _asha_trial_ended_two_days_ago():
    """Asha's Connected trial held the household and ended 2 days ago: both lapsed, the same
    7 days."""
    asha, asha_id, asha_email = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    end = datetime.now(UTC) - timedelta(days=2)
    set_user(asha_id, trial_ends_at=end)
    b = access(ben)
    assert b["state"] == "lapsed" and b["shared"] == "covered"
    return asha, asha_id, asha_email, ben, ben_id, ben_email, b["delete_at"]


def test_d1_the_holder_deleting_in_the_seven_days_keeps_the_partners_same_window() -> None:
    asha, asha_id, _, ben, ben_id, ben_email, delete_at = _asha_trial_ended_two_days_ago()
    assert asha.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    b = access(ben)
    assert b["state"] == "lapsed" and b["delete_at"] == delete_at, b
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 409
    end = datetime.fromisoformat(delete_at)
    run(datetime.now(UTC), ben_id)  # the ended note for that end
    run(end + timedelta(hours=1), ben_id)
    assert is_deleted(ben_id)
    subjects = mail(ben_email)
    assert subjects.index("Your Qash account has closed") > 0


def test_d1_the_partner_leaving_in_the_seven_days_keeps_both_windows() -> None:
    asha, asha_id, _, ben, ben_id, _, delete_at = _asha_trial_ended_two_days_ago()
    assert ben.post("/api/household/leave").status_code == 204
    for client in (ben, asha):
        state = access(client)
        assert state["state"] == "lapsed" and state["delete_at"] == delete_at, state
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 409


def test_d1_a_split_during_a_dispute_stays_paused_then_follows_its_close() -> None:
    from tests.test_billing_hardening import DisputeStripe, _dispute  # noqa: PLC0415

    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    with get_session_factory()() as db:
        row = db.scalar(select(Subscription).where(Subscription.user_id == asha_id))
        assert row is not None
        customer = row.customer_id
    stripe_billing.transport_override = DisputeStripe(customer).transport()
    assert post_event(asha, _dispute("charge.dispute.created")).status_code == 200
    assert access(ben)["state"] == "paused"
    assert ben.post("/api/household/leave").status_code == 204
    assert access(ben)["state"] == "paused"  # still waiting on the dispute, never closed
    assert ben.post("/api/billing/trial", json={"plan": "connected"}).status_code == 409
    run(datetime.now(UTC) + timedelta(days=30), ben_id)
    assert not is_deleted(ben_id)
    closed = post_event(asha, _dispute("charge.dispute.closed", "won"))
    assert closed.status_code == 200, closed.text
    b = access(ben)
    assert b["state"] == "lapsed", b  # his own 7 days start when the dispute closes
    started = datetime.fromisoformat(b["ended_at"])
    assert abs((datetime.now(UTC) - started).total_seconds()) < 60
    assert datetime.fromisoformat(b["delete_at"]) - started == timedelta(days=7)


def test_d1_one_closing_alone_leaves_the_other_on_the_households_window() -> None:
    asha, asha_id, asha_email, ben, ben_id, ben_email, delete_at = _asha_trial_ended_two_days_ago()
    run(datetime.now(UTC), asha_id)  # only Asha was told
    end = datetime.fromisoformat(delete_at)
    run(end + timedelta(hours=1), asha_id)  # she closes; Ben, never told, is not among them
    assert is_deleted(asha_id) and not is_deleted(ben_id)
    b = access(ben)
    assert b["state"] == "lapsed" and b["delete_at"] == delete_at, b
    run(end + timedelta(hours=2), ben_id)  # told first ...
    assert not is_deleted(ben_id)
    run(end + timedelta(hours=3), ben_id)  # ... then closed
    assert is_deleted(ben_id)


def test_d2_a_connected_joiner_is_not_asked_and_whoever_is_covered_can_stop_their_own() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    grant_plan(str(ben_id), "connected", interval="monthly")
    code = asha.post("/api/household/invites").json()["code"]
    assert ben.post("/api/household/lookup", json={"code": code}).json()["you_pay"] is None
    assert ben.post("/api/household/join", json={"code": code}).status_code == 200
    # The owner's plan holds; Ben is covered and told he also pays, with a way to stop it.
    assert access(asha)["shared"] == "holder"
    assert access(ben) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert ben.get("/api/billing").json()["own_plan"] == "connected"
    assert asha.get("/api/billing").json()["own_plan"] is None


def test_d2_a_connected_joiner_holds_beside_an_owners_trial_and_the_owner_is_covered() -> None:
    asha, asha_id, _ = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, _ = person("Ben")
    grant_plan(str(ben_id), "connected", interval="monthly")
    household(asha, ben)
    assert access(ben)["shared"] == "holder" and access(ben)["state"] == "subscribed"
    assert access(asha) == {"state": "subscribed", "plan": "connected", "shared": "covered"}
    assert asha.get("/api/billing").json()["own_plan"] is None  # her trial isn't a payment


def test_l5_a_tester_plan_without_household_ends_the_partners_cover_with_notice() -> None:
    from app.config import get_settings  # noqa: PLC0415

    asha, asha_id, asha_email = person("Asha")
    saved = get_settings().admin_emails
    get_settings().admin_emails = [asha_email]
    try:
        assert asha.post("/api/billing/tester", json={"plan": "connected"}).status_code == 200
        ben, ben_id, _ = person("Ben")
        household(asha, ben)
        assert access(ben)["shared"] == "covered"
        assert asha.post("/api/billing/tester", json={"plan": "private"}).status_code == 200
        b = access(ben)
        assert b["state"] == "lapsed" and "shared" not in b, b
    finally:
        get_settings().admin_emails = saved


def test_l6_the_seven_days_are_seven_times_24_hours_whatever_the_clock_does() -> None:
    asha, asha_id, _ = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    # Ends just before the US clocks go back (November 1, 2026): the window crosses it.
    end = datetime(2026, 10, 30, 17, 0, tzinfo=UTC)
    set_user(asha_id, trial_ends_at=end)
    state = asha.get("/api/billing/entitlements").json()["access"]
    if state["state"] == "lapsed":
        assert datetime.fromisoformat(state["delete_at"]) - end == timedelta(days=7)
        assert datetime.fromisoformat(state["delete_at"]).astimezone(UTC).hour == 17
    with get_session_factory()() as db:
        from app.models.user import User  # noqa: PLC0415
        from app.rules_server.entitlements import access as access_of  # noqa: PLC0415

        user = db.get(User, asha_id)
        got = access_of(db, user, now=end + timedelta(days=1))
        assert got["delete_at"] - end == timedelta(days=7)
        assert got["delete_at"].astimezone(UTC).hour == 17


def _preview(client) -> dict:
    r = client.get("/api/household/leave/preview")
    assert r.status_code == 200, r.text
    return {row["name"]: row for row in r.json()}


def test_l3_the_leave_sheet_says_what_each_person_keeps() -> None:
    asha, asha_id, _ = person("Asha")
    grant_plan(str(asha_id), "connected")
    ben, ben_id, _ = person("Ben")
    household(asha, ben)
    got = _preview(ben)
    assert got["Asha"]["outcome"] == "keeps" and got["Asha"]["plan"] == "connected"
    assert got["Ben"]["outcome"] == "seven_days" and got["Ben"]["is_me"] is True
    # Ben pays for Private too: he goes back to it instead.
    grant_plan(str(ben_id), "private", interval="monthly")
    assert _preview(asha)["Ben"] == {
        **_preview(asha)["Ben"],
        "outcome": "own_plan",
        "plan": "private",
    }
    # The plan ended for both: each keeps the same date.
    set_subscription(asha_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(hours=1))
    set_subscription(ben_id, status="canceled", ends_at=datetime.now(UTC) - timedelta(hours=2))
    rows = _preview(ben)
    assert {r["outcome"] for r in rows.values()} == {"same_end"}
    assert rows["Asha"]["until"] == rows["Ben"]["until"]
    # Someone outside the household gets 404, as for any household route.
    carl, _, _ = person("Carl")
    assert carl.get("/api/household/leave/preview").status_code == 404
