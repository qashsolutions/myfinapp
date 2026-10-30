"""Why a plan ended, said the same on the Plan screen and in the email (invariant 73).

The screen once said "Your trial has wrapped up" for every end, a paid plan's and a household's
cover's too; the emails already told them apart. One rule, `plan_end.end_reason`, now feeds
both: `GET /api/billing` `ended` and the ended email. Households are covered in
`test_household_matrix.py`; these are the ends of one person's own plan.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db import get_session_factory
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.test_household_matrix import SAYS, _grant, _subs
from tests.test_household_one_plan import person, run, set_user


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _ended_email(email: str) -> str:
    return next(m.subject for m in reversed(outbox()) if m.to == email)


@pytest.mark.parametrize("how", ["trial", "plan", "founding", "payment_returned"])
def test_the_plan_screen_names_the_end_the_email_named(how: str) -> None:
    now = datetime.now(UTC)
    client, user_id, email = person("Asha")
    assert client.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    hour = timedelta(hours=1)
    match how:
        case "trial":
            set_user(user_id, trial_ends_at=now - hour)
        case "plan" | "payment_returned":
            set_user(user_id, trial_ends_at=now - timedelta(days=20))
            _grant(user_id, status="canceled", stripe_status="canceled", ends_at=now - hour)
            if how == "payment_returned":
                with get_session_factory()() as db:
                    stripe_billing.block_purchases(db, user_id, "fraud_warning")
                    db.commit()
        case "founding":
            set_user(user_id, trial_ends_at=now - timedelta(days=20))
            grant_plan(str(user_id), "founding")
            _subs(user_id, ends_at=now - hour)
    run(now, user_id)
    assert client.get("/api/billing/entitlements").json()["access"]["state"] == "lapsed"
    reason = client.get("/api/billing").json()["ended"]
    assert reason == how
    assert SAYS[reason] in _ended_email(email)


def test_no_reason_while_a_plan_is_live() -> None:
    client, _, _ = person("Ben")
    assert client.post("/api/billing/trial", json={"plan": "private"}).status_code == 200
    assert client.get("/api/billing").json()["ended"] is None


def test_a_founding_holders_lost_dispute_tells_the_partner_only_that_their_cover_ended(
    monkeypatch,
) -> None:
    """Founding held by the household's owner, lost to a dispute: the partner hears "the plan
    that covered you has ended", by email and push, never "Founding" or the dispute (owner
    decision, October 29, 2026). Before invariant 73 the push said Founding had ended."""
    from app.jobs import plan_lifecycle
    from app.services.alerts import PLAN_ENDED_LABEL
    from tests.test_household_one_plan import household

    pushed: list[tuple[str, str]] = []
    real = plan_lifecycle._push

    def record(db, user_id, now, *, body=PLAN_ENDED_LABEL, tag="plan-ended"):
        pushed.append((str(user_id), body))
        real(db, user_id, now, body=body, tag=tag)

    monkeypatch.setattr(plan_lifecycle, "_push", record)
    now = datetime.now(UTC)
    asha, asha_id, _ = person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_id, ben_email = person("Ben")
    household(asha, ben)
    set_user(asha_id, trial_ends_at=now - timedelta(days=25))
    grant_plan(str(asha_id), "founding")
    hour = timedelta(hours=1)
    _subs(
        asha_id,
        status="canceled",
        stripe_status="canceled",
        ends_at=now - hour,
        disputed_at=now - 2 * hour,
        dispute_lost_at=now - hour,
    )
    run(now, asha_id, ben_id)
    assert ben.get("/api/billing").json()["ended"] == "holder_lost"
    assert _ended_email(ben_email) == SAYS["holder_lost"]
    assert (str(ben_id), PLAN_ENDED_LABEL) in pushed
    assert all(body == PLAN_ENDED_LABEL for who, body in pushed if who == str(ben_id))
