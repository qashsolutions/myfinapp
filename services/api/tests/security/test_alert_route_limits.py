"""Invariant: a route whose success sends an always-on alert email counts, per signed-in device,
so a stolen or scripted session cannot flood the owner's inbox (rate_limit.LIMITS, 10 a day
each, signed off October 28, 2026). For every such route: with nine attempts already counted
today the tenth goes through and emails, the eleventh is 429 and emails nothing."""

from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from app.config import get_settings
from app.db import get_session_factory
from app.linking import plaid
from app.security.hashing import pseudonym
from app.security.rate_limit import LIMITS, window_start
from tests.auth_flow import MAC_UA, new_client, outbox, sign_in_with_code, sign_up
from tests.billing_helpers import grant_plan
from tests.plaid_fake import FakePlaid
from tests.test_backup import KEY
from tests.test_linking import start
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    saved = get_settings().admin_emails
    yield
    get_settings().admin_emails = saved
    plaid.transport_override = None


def _member(name: str, plan: str | None = None):
    client = new_client()
    email = f"{name}+{datetime.now(UTC).timestamp()}@example.com".replace(".", "-", 1)
    info = sign_up(client, email, FakeAuthenticator())
    if plan:
        grant_plan(info["user"]["id"], plan)
    return client, email


def _prime(client, scope: str, hits: int) -> None:
    """Count `hits` attempts in today's window for this device, as earlier requests would."""
    limit = LIMITS[scope]
    key = pseudonym(f"s:{pseudonym(client.cookies.get('stackd_session'))}")
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "INSERT INTO rate_limit_buckets (scope, key, window_start, hits) "
                "VALUES (:scope, :key, :start, :hits) "
                "ON CONFLICT (scope, key, window_start) DO UPDATE SET hits = :hits"
            ),
            {
                "scope": scope,
                "key": key,
                "start": window_start(datetime.now(UTC), limit.window),
                "hits": hits,
            },
        )


def _passkey_add(name: str):
    client, email = _member(name)

    def act():
        options = client.post("/api/security/passkeys/register/options").json()["options"]
        credential = FakeAuthenticator().register(options)
        return client.post(
            "/api/security/passkeys/register/verify", json={"credential": credential}
        )

    return client, email, act


def _passkey_remove(name: str):
    client, email = _member(name)
    for _ in range(2):  # two to remove, and the first one stays
        options = client.post("/api/security/passkeys/register/options").json()["options"]
        credential = FakeAuthenticator().register(options)
        r = client.post("/api/security/passkeys/register/verify", json={"credential": credential})
        assert r.status_code == 200, r.text
    extra = [p["id"] for p in client.get("/api/security/passkeys").json()][1:]
    return client, email, lambda: client.delete(f"/api/security/passkeys/{extra.pop()}")


def _device_sign_out(name: str):
    client, email = _member(name)
    for _ in range(2):
        sign_in_with_code(new_client(MAC_UA), email)
    others = [d["id"] for d in client.get("/api/security/devices").json() if not d["current"]]
    return client, email, lambda: client.delete(f"/api/security/devices/{others.pop()}")


def _device_link_approve(name: str):
    client, email = _member(name)
    computers = []
    for _ in range(2):
        computer = new_client(MAC_UA)
        computers.append((computer, computer.post("/api/auth/link/start").json()["code"]))

    def act():
        computer, code = computers.pop()
        body = {"code": code, "confirm_different_network": True}
        r = client.post("/api/auth/link/approve", json=body)
        computer.get("/api/auth/link/status")  # the new device signs in: its alert goes out
        return r

    return client, email, act


def _backup_key(name: str):
    client, email = _member(name, "private")
    assert client.put("/api/backup/key", json=KEY).status_code == 200  # the first: no alert
    return client, email, lambda: client.put("/api/backup/key", json=KEY)


def _backup_off(name: str):
    client, email = _member(name, "private")

    def act():
        assert client.put("/api/backup/key", json=KEY).status_code == 200
        return client.delete("/api/backup")

    return client, email, act


def _tester_plan(name: str):
    client, email = _member(name)
    get_settings().admin_emails = [email]
    return client, email, lambda: client.post("/api/billing/tester", json={"plan": "private"})


def _bank_link_finish(name: str):
    client, email = _member(name, "connected")
    fake = FakePlaid()
    plaid.transport_override = fake.transport()
    banks = ["First Platypus Bank", "Tartan Bank"]

    def act():
        session_id = start(client, fake, banks.pop())
        return client.post("/api/linking/finish", json={"session_id": session_id})

    return client, email, act


def _bank_disconnect(name: str):
    client, email = _member(name, "connected")
    fake = FakePlaid()
    plaid.transport_override = fake.transport()
    ids = []
    for bank in ("First Platypus Bank", "Tartan Bank"):
        session_id = start(client, fake, bank)
        r = client.post("/api/linking/finish", json={"session_id": session_id})
        ids.append(r.json()["connections"][0]["id"])
    return client, email, lambda: client.delete(f"/api/linking/{ids.pop()}")


CASES: dict[str, Callable] = {
    "passkey_add": _passkey_add,
    "passkey_remove": _passkey_remove,
    "device_sign_out": _device_sign_out,
    "device_link_approve": _device_link_approve,
    "backup_key": _backup_key,
    "backup_off": _backup_off,
    "tester_plan": _tester_plan,
    "bank_link_finish": _bank_link_finish,
    "bank_disconnect": _bank_disconnect,
}


@pytest.mark.parametrize("scope", sorted(CASES))
def test_the_eleventh_alerting_call_in_a_day_is_refused_and_emails_nothing(scope: str) -> None:
    limit = LIMITS[scope]
    assert (limit.max_hits, limit.window.total_seconds()) == (10, 24 * 3600)
    client, email, act = CASES[scope](scope.replace("_", ""))
    _prime(client, scope, limit.max_hits - 1)

    def mails() -> int:
        return len([m for m in outbox() if m.to == email])

    before = mails()
    r = act()  # the tenth today
    assert r.status_code < 300, r.text
    assert mails() == before + 1  # its always-on alert

    r = act()  # the eleventh
    assert (r.status_code, r.json()["detail"]) == (429, "rate_limited")
    assert int(r.headers["retry-after"]) > 0
    assert mails() == before + 1
