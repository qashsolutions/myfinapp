"""Who may start a purchase (owner decision, October 26, 2026): STACKD_BILLING_OPEN is "off",
"admins" or "everyone", and unset means "off" in production. Live Stripe keys in production's
settings never open sales by themselves; someone already paying can still manage their plan."""

import pytest

from app.config import get_settings
from app.services import stripe_billing
from tests.auth_flow import outbox
from tests.billing_helpers import grant_plan
from tests.conftest import stripe_default_transport
from tests.test_billing import FakeStripe, buy, member


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    s = get_settings()
    saved = (s.env, s.billing_open, s.admin_emails)
    stripe_billing.transport_override = stripe_default_transport()
    yield
    s.env, s.billing_open, s.admin_emails = saved
    stripe_billing.transport_override = None


def _set(env: str, mode: str | None) -> FakeStripe:
    s = get_settings()
    s.env, s.billing_open = env, mode
    stripe = FakeStripe()
    stripe_billing.transport_override = stripe.transport()
    return stripe


def _try(client) -> int:
    return client.post(
        "/api/billing/checkout", json=buy(plan="private", interval="monthly")
    ).status_code


def test_production_with_every_stripe_setting_still_sells_nothing_until_opened() -> None:
    client, _ = member("early")
    stripe = _set("prod", None)
    assert stripe_billing.configured()  # all seven Stripe settings present
    assert client.get("/api/billing").json()["available"] is False
    assert _try(client) == 503
    assert client.post("/api/billing/checkout", json=buy(plan="founding")).status_code == 503
    _set("prod", "off")
    assert _try(client) == 503
    assert stripe.requests == []  # Stripe never asked


def test_admins_only_lets_the_admins_buy() -> None:
    plain, _ = member("plain")
    boss, _ = member("boss")
    get_settings().admin_emails = [boss.get("/api/auth/session").json()["user"]["email"]]
    stripe = _set("prod", "admins")
    assert plain.get("/api/billing").json()["available"] is False
    assert _try(plain) == 503
    assert stripe.requests == []
    assert boss.get("/api/billing").json()["available"] is True
    assert _try(boss) == 200
    assert len(stripe.requests) == 1


def test_everyone_opens_sales_and_development_is_open_by_default() -> None:
    client, _ = member("buyer")
    _set("prod", "everyone")
    assert _try(client) == 200
    _set("dev", None)
    assert client.get("/api/billing").json()["available"] is True
    assert _try(client) == 200


def test_someone_already_paying_can_still_manage_their_plan_when_sales_are_off() -> None:
    client, user_id = member("payer")
    grant_plan(user_id, "private")
    _set("prod", "off")
    assert client.get("/api/billing").json()["available"] is True
    assert client.post("/api/billing/portal").status_code == 200


def test_a_blank_setting_means_unset_so_production_stays_shut(monkeypatch) -> None:
    from app.config import Settings

    monkeypatch.setenv("STACKD_BILLING_OPEN", "")
    assert Settings().billing_open is None
    monkeypatch.setenv("STACKD_BILLING_OPEN", "nonsense")
    with pytest.raises(ValueError):
        Settings()
