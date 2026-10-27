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
from tests.test_billing import CONSENT, FakeStripe
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
    assert access(client) == {"state": "choose", "plan": "free"}
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
    body = {"plan": "private", "interval": "yearly", "consent": CONSENT}
    assert client.post("/api/billing/checkout", json=body).status_code == 200
    form = dict(p.split("=", 1) for p in stripe.requests[-1].content.decode().split("&"))
    trial_end = int(form["subscription_data%5Btrial_end%5D"])
    assert abs(trial_end - (datetime.now(UTC) + timedelta(days=3)).timestamp()) < 120


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
