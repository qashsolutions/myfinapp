"""Trials instead of a lasting Free plan (owner decision, October 14, 2026)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs import plan_lifecycle
from app.models.trial_claim import TrialClaim, trial_hashes
from app.models.user import User
from app.security.hashing import pseudonym
from app.services import stripe_billing
from app.services.deletion import soft_delete
from tests.auth_flow import new_client, outbox, sign_up
from tests.conftest import stripe_default_transport
from tests.test_billing import FakeStripe, buy
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None


def signed_up(email: str | None = None):
    email = email or f"t-{uuid.uuid4().hex[:8]}@example.com"
    client = new_client()
    sign_up(client, email, FakeAuthenticator())
    return client, uuid.UUID(client.get("/api/auth/session").json()["user"]["id"]), email


def access(client) -> dict:
    return client.get("/api/billing/entitlements").json()["access"]


def set_user(user_id: uuid.UUID, **fields) -> None:
    with get_session_factory()() as db:
        user = db.get(User, user_id)
        assert user is not None
        for k, v in fields.items():
            setattr(user, k, v)
        db.commit()


def test_a_new_account_picks_one_trial_with_no_card() -> None:
    client, _, _ = signed_up()
    assert access(client) == {"state": "choose", "plan": "free", "trial_used": False}
    r = client.post("/api/billing/trial", json={"plan": "connected"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["plan"] == "connected" and got["bank_links_max"] == 3
    state = got["access"]
    ends = datetime.fromisoformat(state["trial_ends_at"])
    card = datetime.fromisoformat(state["card_from"])
    assert state["state"] == "trial" and state["plan"] == "connected"
    assert timedelta(days=2, hours=23) < ends - datetime.now(UTC) <= timedelta(days=3)
    assert ends - card == timedelta(days=2)  # day 2 of 3: the card is asked for from here
    assert state["days"] == 3
    # One trial: no switching, no second start.
    again = client.post("/api/billing/trial", json={"plan": "private"})
    assert again.status_code == 409 and again.json()["detail"] == "trial_not_available"


def test_private_trial_is_3_days_and_asks_for_a_card_from_day_2() -> None:
    client, _, _ = signed_up()
    state = client.post("/api/billing/trial", json={"plan": "private"}).json()["access"]
    ends = datetime.fromisoformat(state["trial_ends_at"])
    assert ends - datetime.fromisoformat(state["card_from"]) == timedelta(days=2)
    assert timedelta(days=2, hours=23) < ends - datetime.now(UTC) <= timedelta(days=3)


def test_a_trial_started_before_october_22_keeps_its_own_length() -> None:
    """Owner decision, October 22, 2026: 3-day trials from now on; a 45-day one already running
    keeps its end and shows its own length."""
    client, user_id, email = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    claimed = datetime.now(UTC) - timedelta(days=10)
    with get_session_factory()() as db:
        claim = db.scalar(select(TrialClaim).where(TrialClaim.email_hash == pseudonym(email)))
        assert claim is not None
        claim.claimed_at = claimed
        db.commit()
    set_user(user_id, trial_ends_at=claimed + timedelta(days=45))
    state = access(client)
    assert state["state"] == "trial" and state["days"] == 45
    ends = datetime.fromisoformat(state["trial_ends_at"])
    assert ends - datetime.fromisoformat(state["card_from"]) == timedelta(days=2)


def test_one_trial_per_email_even_after_deleting_the_account() -> None:
    client, user_id, email = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    with get_session_factory()() as db:
        user = db.get(User, user_id)
        assert user is not None
        soft_delete(db, user)
        db.commit()
    again, _, _ = signed_up(email)
    r = again.post("/api/billing/trial", json={"plan": "connected"})
    assert r.status_code == 409 and r.json()["detail"] == "trial_used"


def test_subscribing_during_a_trial_charges_only_when_it_ends() -> None:
    client, _, _ = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    body = buy(client, plan="private", interval="yearly")
    assert client.post("/api/billing/checkout", json=body).status_code == 200
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    trial_end = int(form["subscription_data%5Btrial_end%5D"])
    assert abs(trial_end - (datetime.now(UTC) + timedelta(days=3)).timestamp()) < 120


def _checkout_form(client) -> tuple[dict[str, str], list[str]]:
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    body = buy(client, plan="private", interval="yearly")
    r = client.post("/api/billing/checkout", json=body)
    assert r.status_code == 200, r.text
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    return form, body["consent"]["lines"]


def test_subscribing_late_in_a_trial_still_charges_nothing_until_it_ends() -> None:
    """Owner decision, October 28, 2026: nothing is charged until the trial ends, whenever the
    person subscribes during it. Stripe's trial_end needs 48 hours, so closer than that the
    billing cycle is anchored on the trial end with no proration: $0 today, the first charge
    on the trial-end day."""
    client, user_id, _ = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    ends = datetime.now(UTC) + timedelta(hours=30)
    set_user(user_id, trial_ends_at=ends)
    form, lines = _checkout_form(client)
    assert "subscription_data%5Btrial_end%5D" not in form
    assert abs(int(form["subscription_data%5Bbilling_cycle_anchor%5D"]) - ends.timestamp()) < 2
    assert form["subscription_data%5Bproration_behavior%5D"] == "none"
    # Every payment page closes after 31 minutes (October 29, 2026), well before the anchor.
    left = int(form["expires_at"]) - datetime.now(UTC).timestamp()
    assert 30 * 60 < left <= 31 * 60 + 2
    assert lines[0].startswith("Free until ") and "today" not in lines[0]
    # Closer still, the page closes by the trial end, so it is never paid after it.
    ends = datetime.now(UTC) + timedelta(minutes=40)
    set_user(user_id, trial_ends_at=ends)
    form, lines = _checkout_form(client)
    assert abs(int(form["subscription_data%5Bbilling_cycle_anchor%5D"]) - ends.timestamp()) < 2
    assert int(form["expires_at"]) <= int(ends.timestamp())
    assert lines[0].startswith("Free until ")


def test_subscribing_early_in_a_trial_uses_stripes_trial() -> None:
    client, user_id, _ = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    ends = datetime.now(UTC) + timedelta(hours=60)
    set_user(user_id, trial_ends_at=ends)
    form, lines = _checkout_form(client)
    assert abs(int(form["subscription_data%5Btrial_end%5D"]) - ends.timestamp()) < 2
    assert "subscription_data%5Bbilling_cycle_anchor%5D" not in form
    assert lines[0].startswith("Free until ")


def test_subscribing_in_a_trials_last_minutes_charges_today_and_says_so() -> None:
    """Under Stripe's 30-minute shortest payment page the trial is over before the page could
    close, so the first charge is today, and the words say today."""
    client, user_id, _ = signed_up()
    client.post("/api/billing/trial", json={"plan": "private"})
    set_user(user_id, trial_ends_at=datetime.now(UTC) + timedelta(minutes=20))
    form, lines = _checkout_form(client)
    assert "subscription_data%5Btrial_end%5D" not in form
    assert "subscription_data%5Bbilling_cycle_anchor%5D" not in form
    assert lines[0] == "$20.00 today, then every year."


def test_ending_soon_ended_then_deleted_after_seven_days() -> None:
    client, user_id, email = signed_up()
    client.post("/api/billing/trial", json={"plan": "connected"})
    now = datetime.now(UTC)
    set_user(user_id, trial_ends_at=now + timedelta(days=1))
    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now, only={user_id})["ending_soon"] == 1
        assert (
            plan_lifecycle.run(db, now=now, only={user_id})["ending_soon"] == 0
        )  # once per end date
    sent = [m for m in outbox() if m.to == email]
    assert sent[-1].subject.startswith("Your free trial wraps up on")
    assert "/me/plan" in sent[-1].text and "$" not in sent[-1].text

    set_user(user_id, trial_ends_at=now - timedelta(hours=1))
    assert access(client)["state"] == "lapsed"
    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now, only={user_id})["ended"] == 1
        # One friendly reminder a day after that, never two on one day (October 20, 2026). Later
        # the same day, not "2 hours later", which is tomorrow after 22:00 UTC.
        same_day = now.replace(hour=23, minute=59)
        assert plan_lifecycle.run(db, now=same_day, only={user_id})["reminded"] == 0
        day3 = plan_lifecycle.run(db, now=now + timedelta(days=3), only={user_id})
        assert day3["reminded"] == 1 and day3["deleted"] == 0
        assert plan_lifecycle.run(db, now=now + timedelta(days=6), only={user_id})["deleted"] == 0
    subjects = [m.subject for m in outbox() if m.to == email]
    assert "Your Qash trial has wrapped up" in subjects
    assert "A friendly reminder: 4 days left to keep your Qash account" in subjects
    reminder = next(m for m in outbox() if m.subject.startswith("A friendly reminder: 4 days"))
    assert "stays there until you decide" in reminder.text and "$" not in reminder.text

    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now + timedelta(days=7), only={user_id})["deleted"] == 1
        user = db.get(User, user_id)
        assert user is not None and user.deleted_at is not None
    assert outbox()[-1].subject == "Your Qash account has closed"
    # This device learns its account closed because the plan ended: it keeps what it holds
    # until the person decides (October 20, 2026), unlike a deletion they asked for.
    info = client.get("/api/auth/session").json()
    assert info["authenticated"] is False and info["deleted_user_id"] == str(user_id)
    assert info["deleted_reason"] == "plan_ended"
    # Said once: the stale cookie is cleared, so the device then simply starts fresh.
    assert client.get("/api/auth/session").json()["deleted_user_id"] is None


def test_one_account_failing_never_undoes_or_resends_the_others(monkeypatch) -> None:
    """Invariant: a job's failure for one account stays with that account (October 28, 2026).
    Before, one failing send rolled back every stamp of the run, so the next hour re-sent
    every email already sent."""
    from app.jobs import plan_lifecycle as job
    from app.services import email, ops_alerts

    _, a_id, a_email = signed_up()
    _, b_id, b_email = signed_up()
    now = datetime.now(UTC)
    for uid in (a_id, b_id):
        set_user(uid, trial_plan="connected", trial_ends_at=now + timedelta(days=1))
    real = email.get_sender()

    class Flaky:
        def send(self, message) -> None:
            if message.to == a_email:
                raise RuntimeError("smtp refused")
            real.send(message)

    monkeypatch.setattr(email, "get_sender", lambda: Flaky())
    reports: list[tuple[str, str]] = []
    monkeypatch.setattr(
        ops_alerts, "report", lambda kind, where, exc: reports.append((kind, where))
    )
    for _ in range(2):  # the next hour's run sends B nothing again
        with get_session_factory()() as db:
            job.run(db, now=now, only={a_id, b_id})
    notices = [m for m in outbox() if m.to == b_email and "wraps up" in m.subject]
    assert len(notices) == 1
    assert reports == [("plan_lifecycle_failed", "plan_lifecycle.run")] * 2
    with get_session_factory()() as db:
        a, b = db.get(User, a_id), db.get(User, b_id)
        assert a is not None and b is not None
        assert a.ending_notice_for is None  # tried again next hour
        assert b.ending_notice_for is not None


def test_choosing_never_starts_a_clock() -> None:
    client, user_id, _ = signed_up()
    with get_session_factory()() as db:
        counts = plan_lifecycle.run(db, now=datetime.now(UTC) + timedelta(days=90), only={user_id})
    assert counts == {"ending_soon": 0, "ended": 0, "reminded": 0, "deleted": 0}
    assert access(client)["state"] == "choose"


def test_a_deletion_the_person_asked_for_tells_the_device_to_erase() -> None:
    client, user_id, _ = signed_up()
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    info = client.get("/api/auth/session").json()
    assert info["deleted_user_id"] == str(user_id) and info["deleted_reason"] == "requested"


def test_canonical_email_folds_plus_tags_and_gmail_dots() -> None:
    from app.services.otp import canonical_email

    assert canonical_email(" Maya+Qash@Gmail.com ") == "maya@gmail.com"
    assert canonical_email("m.a.y.a@googlemail.com") == "maya@gmail.com"
    assert canonical_email("m.aya+x@example.com") == "m.aya@example.com"  # dots kept elsewhere
    assert canonical_email("+only@example.com") == "+only@example.com"  # nothing left: as is


def test_one_trial_per_inbox_plus_and_dot_variants_count_as_one() -> None:
    """Owner decision, October 24, 2026: maya+2@ and m.aya@gmail.com are the same person."""
    base = f"trialer{uuid.uuid4().hex[:6]}"
    first, _, _ = signed_up(f"{base}+one@gmail.com")
    assert first.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    for variant in (f"{base}@gmail.com", f"{base[:3]}.{base[3:]}+two@googlemail.com"):
        again, _, _ = signed_up(variant)
        r = again.post("/api/billing/trial", json={"plan": "connected"})
        assert r.status_code == 409 and r.json()["detail"] == "trial_used", variant
    # Someone else's inbox is unaffected
    other, _, _ = signed_up(f"{base}x@gmail.com")
    assert other.post("/api/billing/trial", json={"plan": "private"}).status_code == 200


def test_a_trial_claimed_before_the_change_still_counts() -> None:
    """Claims made before October 24, 2026 were keyed on the exact address: they still block
    that address and still give a running trial its length. (Their hash is one-way, so an old
    claim under maya+tag@ cannot be folded into maya@; there were no public users then.)"""
    client, _, email = signed_up(f"old{uuid.uuid4().hex[:6]}+tag@example.com")
    client.post("/api/billing/trial", json={"plan": "private"})
    with get_session_factory()() as db:
        claim = db.scalar(select(TrialClaim).where(TrialClaim.email_hash.in_(trial_hashes(email))))
        assert claim is not None
        claim.email_hash = pseudonym(email)  # as an older claim was stored
        db.commit()
    state = access(client)
    assert state["state"] == "trial" and state["days"] == 3
    with get_session_factory()() as db:
        user = db.scalar(select(User).where(User.email == email))
        assert user is not None
        soft_delete(db, user)
        db.commit()
    again, _, _ = signed_up(email)
    r = again.post("/api/billing/trial", json={"plan": "private"})
    assert r.status_code == 409 and r.json()["detail"] == "trial_used"


def test_the_words_and_the_checkout_share_one_threshold() -> None:
    from app.services import consent_text

    assert consent_text.ANCHOR_MIN == stripe_billing.ANCHOR_MIN


def test_the_day_before_a_trial_ends_one_push_goes_with_the_email(monkeypatch) -> None:
    """Owner, October 28, 2026: the "ends tomorrow" email gets a push beside it, once, with
    fixed words; nothing daily during the trial."""
    from app.jobs import alert_dispatch
    from app.services.alerts import TRIAL_ENDS_TOMORROW_LABEL

    sent: list[tuple[uuid.UUID, dict]] = []
    monkeypatch.setattr(
        alert_dispatch, "_deliver", lambda db, uid, payload, now: sent.append((uid, payload))
    )
    client, user_id, _ = signed_up()
    client.post("/api/billing/trial", json={"plan": "connected"})
    now = datetime.now(UTC)
    with get_session_factory()() as db:
        plan_lifecycle.run(db, now=now, only={user_id})  # three days to go: nothing
    assert sent == []
    set_user(user_id, trial_ends_at=now + timedelta(hours=20))
    with get_session_factory()() as db:
        assert plan_lifecycle.run(db, now=now, only={user_id})["ending_soon"] == 1
        plan_lifecycle.run(db, now=now + timedelta(hours=2), only={user_id})
    assert TRIAL_ENDS_TOMORROW_LABEL == "Your Qash trial ends tomorrow. Pick a plan to keep going."
    assert [p["body"] for _, p in sent] == [TRIAL_ENDS_TOMORROW_LABEL]
    assert sent[0][0] == user_id and sent[0][1]["url"] == "/me/plan"


def test_signing_up_again_says_the_trial_was_used_so_the_app_offers_plans() -> None:
    """A returning person (deleted, then signed up again with the same inbox) is told up front
    that the trial was used, and can still buy: checkout is open to them in the choose state."""
    email = f"back-{uuid.uuid4().hex[:8]}@example.com"
    first, _, _ = signed_up(email)
    assert first.post("/api/billing/trial", json={"plan": "private"}).status_code == 200
    assert first.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    again, _, _ = signed_up(email)
    assert access(again) == {"state": "choose", "plan": "free", "trial_used": True}
    r = again.post("/api/billing/trial", json={"plan": "private"})
    assert r.status_code == 409 and r.json()["detail"] == "trial_used"
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    body = buy(again, plan="private", interval="monthly")
    assert again.post("/api/billing/checkout", json=body).status_code == 200
