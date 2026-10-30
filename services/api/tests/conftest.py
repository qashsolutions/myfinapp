from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine

import tests._env  # noqa: F401  # sets STACKD_* before any `app` import below
from app.config import get_settings
from app.db import alembic_config, get_engine
from app.main import create_app
from app.storage import ensure_bucket


@pytest.fixture(scope="session")
def engine() -> Engine:
    return get_engine()


@pytest.fixture(scope="session")
def migrated(engine: Engine) -> Iterator[Engine]:
    """A test database at migration head, rebuilt from scratch for the session."""
    cfg = alembic_config()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield engine
    command.downgrade(cfg, "base")


@pytest.fixture(scope="session")
def bucket() -> str:
    ensure_bucket()
    return tests._env.TEST_BUCKET


@pytest.fixture
def prod_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Settings as production requires them (the validator refuses dev values in prod)."""
    monkeypatch.setenv("STACKD_ENV", "prod")
    monkeypatch.setenv("STACKD_COOKIE_SECURE", "true")
    monkeypatch.setenv("STACKD_EMAIL_BACKEND", "smtp")
    monkeypatch.setenv("STACKD_RP_ID", "app.example")
    monkeypatch.setenv("STACKD_ORIGINS", '["https://app.example"]')
    monkeypatch.setenv("STACKD_SITE_ORIGIN", "https://www.example")
    monkeypatch.setenv("STACKD_ORIGIN_VERIFY", "test-origin-verify")
    monkeypatch.setenv("STACKD_TRUST_PROXY_HEADERS", "true")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as c:
        yield c


def stripe_default_transport():
    """Tests never reach the real Stripe. By default (a test may set its own fake), ending a
    subscription succeeds, as account deletion now does (October 16, 2026), and a customer has
    no credit to refund (October 17, 2026); anything else 404s."""
    import httpx2

    def handle(request: httpx2.Request) -> httpx2.Response:
        if request.method == "DELETE" and request.url.path.startswith("/v1/subscriptions/"):
            return httpx2.Response(200, json={"status": "canceled"})
        if request.method == "GET" and request.url.path.startswith("/v1/subscriptions/"):
            # No period dates: nothing after the current month to refund.
            return httpx2.Response(200, json={"id": "sub", "items": {"data": [{"id": "si"}]}})
        if request.method == "GET" and request.url.path.startswith("/v1/payment_intents/"):
            card = {"payment_method_details": {"type": "card"}}
            return httpx2.Response(200, json={"id": "pi", "latest_charge": card})
        if request.method == "GET" and request.url.path in ("/v1/charges", "/v1/refunds"):
            return httpx2.Response(200, json={"data": []})
        if request.method == "GET" and request.url.path.startswith("/v1/customers/"):
            return httpx2.Response(
                200, json={"id": request.url.path.rsplit("/", 1)[-1], "balance": 0}
            )
        return httpx2.Response(404, json={"error": "no fake for this call"})

    return httpx2.MockTransport(handle)


# The challenges' clock (October 29, 2026): every test that creates a challenge for "2026-10"
# would stop working once October is over everywhere (invariants 56 and 71), so the groups
# router reads this fixed moment; a test that needs another one sets `groups._now` itself.
GROUPS_NOW = datetime(2026, 10, 15, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _groups_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import groups

    monkeypatch.setattr(groups, "_now", lambda: GROUPS_NOW)


@pytest.fixture(autouse=True)
def _no_real_stripe():
    from app.services import stripe_billing

    stripe_billing.transport_override = stripe_default_transport()
    yield
    stripe_billing.transport_override = None
