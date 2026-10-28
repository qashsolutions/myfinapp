"""Founding reminders (owner decision, October 28, 2026): as the 4 years end, an email and a push
30 days, 7 days and 1 day before, then "ended" on the day; then the usual 7 days to pick a plan
or download, with the device's data kept. Each goes once. Prices come from plans.yaml; pushes
are fixed words with no prices."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs import plan_lifecycle
from app.models.billing import Subscription
from app.rules_server.entitlements import load_plans
from app.services.alerts import (
    FOUNDING_ENDED_LABEL,
    FOUNDING_ENDS_SOON_LABEL,
    PLAN_ENDED_LABEL,
)
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.test_billing import member


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


@pytest.fixture
def pushes(monkeypatch):
    sent: list[tuple[uuid.UUID, str]] = []

    def fake(db, user_id, now, *, body=PLAN_ENDED_LABEL, tag="plan-ended"):
        sent.append((user_id, body))

    monkeypatch.setattr(plan_lifecycle, "_push", fake)
    return sent


def _ends(user_id: str, at: datetime) -> None:
    with get_session_factory()() as db:
        for row in db.scalars(
            select(Subscription).where(Subscription.user_id == uuid.UUID(user_id))
        ):
            row.ends_at = at
        db.commit()


def _run(user_id: str, now: datetime) -> dict[str, int]:
    with get_session_factory()() as db:
        return plan_lifecycle.run(db, now=now, only={uuid.UUID(user_id)})


def _dollars(cents: int) -> str:
    return f"${cents // 100}" if cents % 100 == 0 else f"${cents / 100:.2f}"


def _mine(email_to: str):
    return [m for m in outbox() if m.to == email_to]


def test_thirty_seven_one_then_ended_each_once(pushes) -> None:
    client, user_id = member("found")
    address = client.get("/api/auth/session").json()["user"]["email"]
    outbox().clear()  # the sign-up emails
    grant_plan(user_id, "founding")
    end = datetime(2030, 11, 14, 15, 0, tzinfo=UTC)
    _ends(user_id, end)
    me = uuid.UUID(user_id)

    # Long before: nothing.
    assert _run(user_id, end - timedelta(days=45))["ending_soon"] == 0
    assert _mine(address) == [] and pushes == []

    prices = load_plans()["plans"]
    priv, conn = prices["private"]["price_cents"], prices["connected"]["price_cents"]
    choice = (
        f"pick Private ({_dollars(priv['monthly'])} a month or {_dollars(priv['yearly'])} a "
        f"year) or Connected ({_dollars(conn['monthly'])} a month or "
        f"{_dollars(conn['yearly'])} a year)"
    )

    # 30 days before, then again later the same week: one email, one push.
    for now in (end - timedelta(days=30), end - timedelta(days=29), end - timedelta(days=8)):
        _run(user_id, now)
    sent = _mine(address)
    assert [m.subject for m in sent] == ["Your Founding membership ends on November 14, 2030"]
    text = sent[0].text
    assert "Your 4 years of Founding end on November 14, 2030." in text
    assert "Thank you for being one of the first." in text
    assert choice in text, text
    assert "Nothing is charged unless you choose." in text and "/me/plan" in text
    assert pushes == [(me, FOUNDING_ENDS_SOON_LABEL)]

    # 7 days before.
    _run(user_id, end - timedelta(days=7))
    _run(user_id, end - timedelta(days=6))
    sent = _mine(address)
    assert [m.subject for m in sent][1:] == ["Your Founding membership ends on November 14, 2030"]
    assert choice in sent[1].text
    assert pushes[1:] == [(me, FOUNDING_ENDS_SOON_LABEL)]

    # 1 day before: "ends tomorrow".
    _run(user_id, end - timedelta(hours=20))
    _run(user_id, end - timedelta(hours=2))
    sent = _mine(address)
    assert [m.subject for m in sent][2:] == ["Your Founding membership ends tomorrow"]
    assert "Your 4 years of Founding end tomorrow, November 14, 2030." in sent[2].text
    assert choice in sent[2].text and "Nothing is charged unless you choose." in sent[2].text
    assert pushes[2:] == [(me, FOUNDING_ENDS_SOON_LABEL)]

    # On the day: ended, once; then the usual daily reminders for the 7 days.
    after = end + timedelta(hours=1)
    assert _run(user_id, after)["ended"] == 1
    assert _run(user_id, after + timedelta(hours=2))["ended"] == 0
    sent = _mine(address)
    assert [m.subject for m in sent][3:] == ["Your Founding membership has ended"]
    ended = sent[3].text
    assert "Thank you" in ended and "7 days" in ended
    assert "pick a plan or download your data" in ended
    assert "stays there until you decide" in ended
    assert "trial" not in ended.lower()
    assert pushes[3:] == [(me, FOUNDING_ENDED_LABEL)]
    assert _run(user_id, after + timedelta(days=2))["reminded"] == 1

    # Pushes never carry a price, a date or an amount.
    for label in (FOUNDING_ENDS_SOON_LABEL, FOUNDING_ENDED_LABEL, PLAN_ENDED_LABEL):
        assert "$" not in label and not any(ch.isdigit() for ch in label)
        assert "trial" not in label.lower()


def test_a_job_that_missed_a_stage_sends_only_the_current_one(pushes) -> None:
    client, user_id = member("foundlate")
    address = client.get("/api/auth/session").json()["user"]["email"]
    outbox().clear()  # the sign-up emails
    grant_plan(user_id, "founding")
    end = datetime(2030, 11, 14, 15, 0, tzinfo=UTC)
    _ends(user_id, end)
    _run(user_id, end - timedelta(days=3))  # the 30-day one never went (an outage)
    assert [m.subject for m in _mine(address)] == [
        "Your Founding membership ends on November 14, 2030"
    ]
    _run(user_id, end - timedelta(days=2))
    assert len(_mine(address)) == 1
    assert len(pushes) == 1


def test_a_founding_member_who_picked_a_plan_hears_nothing_more(pushes) -> None:
    client, user_id = member("foundnext")
    address = client.get("/api/auth/session").json()["user"]["email"]
    outbox().clear()  # the sign-up emails
    grant_plan(user_id, "founding")
    end = datetime.now(UTC) + timedelta(days=5)
    _ends(user_id, end)
    grant_plan(user_id, "private")  # chose to keep going: a renewing plan beside it
    _run(user_id, end - timedelta(days=1))
    assert _mine(address) == [] and pushes == []


def test_a_paid_plan_that_ended_never_says_trial(pushes) -> None:
    client, user_id = member("paidend")
    address = client.get("/api/auth/session").json()["user"]["email"]
    outbox().clear()  # the sign-up emails
    grant_plan(user_id, "private", interval="monthly")
    now = datetime.now(UTC)
    with get_session_factory()() as db:
        for row in db.scalars(
            select(Subscription).where(Subscription.user_id == uuid.UUID(user_id))
        ):
            row.status = "canceled"
            row.ends_at = now - timedelta(hours=1)
        db.commit()
    assert _run(user_id, now)["ended"] == 1
    (sent,) = _mine(address)
    assert sent.subject == "Your Qash plan has wrapped up"
    assert "trial" not in sent.text.lower()
