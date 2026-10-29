"""Invariant 32: a code's attempts are counted one at a time, however many guesses arrive at
once. Twelve wrong codes sent together used to be judged against the same count, so the address
never locked; the public deletion page checks codes with no passkey, so guessing there could
delete an account. These tests send the guesses in parallel from separate clients (separate
database sessions) against the real Postgres."""

from __future__ import annotations

import re
import threading
import time
import uuid

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.otp_code import OtpCode
from app.services import otp
from app.services import webauthn as webauthn_svc
from tests.auth_flow import new_client, outbox, send_code, sign_up
from tests.webauthn_fake import FakeAuthenticator

GUESSES = 12
SITE = "http://localhost:4321"


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


@pytest.fixture
def slow_compare(monkeypatch: pytest.MonkeyPatch) -> None:
    """Widen the gap between reading the code row and writing the attempt, as a busy server
    would, so parallel guesses overlap every time."""
    real = otp._hash

    def slow(purpose: str, email: str, code: str) -> str:
        time.sleep(0.05)
        return real(purpose, email, code)

    monkeypatch.setattr(otp, "_hash", slow)


def fresh(name: str) -> str:
    return f"{name}+{uuid.uuid4().hex[:6]}@example.com"


def wrong_guess(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


def in_parallel(clients, path: str, bodies: list[dict]) -> list[int]:
    barrier = threading.Barrier(len(bodies))
    out: list[int] = [0] * len(bodies)

    def run(i: int) -> None:
        barrier.wait()
        out[i] = clients[i].post(path, json=bodies[i]).status_code

    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(bodies))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return out


def latest_row(email: str) -> OtpCode:
    with get_session_factory()() as s:
        return s.scalars(
            select(OtpCode).where(OtpCode.email == email).order_by(OtpCode.created_at.desc())
        ).first()


def locked_alerts(email: str) -> int:
    return sum(1 for m in outbox() if m.to == email and "wrong codes" in m.subject.lower())


def test_parallel_sign_in_guesses_lock_after_five_and_alert_once(slow_compare) -> None:
    email = fresh("maya")
    sign_up(new_client(), email, FakeAuthenticator())
    code = send_code(new_client(), email)
    outbox().clear()
    clients = [new_client() for _ in range(GUESSES)]
    bodies = [{"email": email, "code": wrong_guess(code)}] * GUESSES

    statuses = in_parallel(clients, "/api/auth/otp/verify", bodies)

    assert statuses.count(400) == 4, statuses  # wrong_code, 4 then 1 attempt left
    assert statuses.count(423) == GUESSES - 4, statuses  # the fifth locks, the rest are refused
    row = latest_row(email)
    assert row.attempts == 5 and row.locked_until is not None and row.consumed_at is not None
    assert locked_alerts(email) == 1
    # The real code is refused too while locked
    r = new_client().post("/api/auth/otp/verify", json={"email": email, "code": code})
    assert r.status_code == 423


def test_parallel_guesses_on_the_public_deletion_page_never_delete(slow_compare) -> None:
    owner = new_client()
    email = fresh("dana")
    sign_up(owner, email, FakeAuthenticator())
    site = new_client()
    site.headers["origin"] = SITE
    assert site.post("/api/public/account/delete/send", json={"email": email}).status_code == 200
    code = re.search(r"page: (\d{6})", outbox()[-1].text).group(1)
    outbox().clear()
    clients = []
    for _ in range(GUESSES):
        c = new_client()
        c.headers["origin"] = SITE
        clients.append(c)
    bodies = [{"email": email, "code": wrong_guess(code)}] * GUESSES

    statuses = in_parallel(clients, "/api/public/account/delete/verify", bodies)

    assert statuses.count(400) == 4, statuses
    assert statuses.count(429) == GUESSES - 4, statuses
    assert latest_row(email).attempts == 5
    assert locked_alerts(email) == 1
    r = site.post("/api/public/account/delete/verify", json={"email": email, "code": code})
    assert r.status_code == 429
    assert owner.get("/api/auth/session").json()["authenticated"] is True


def test_parallel_email_change_guesses_lock_after_five(slow_compare) -> None:
    client = new_client()
    sign_up(client, fresh("old"), FakeAuthenticator())
    new = fresh("new")
    assert client.post("/api/account/email/send", json={"new_email": new}).status_code == 200
    code = re.search(r"\b(\d{6})\b", outbox()[-1].text).group(1)
    clients = []
    for _ in range(GUESSES):
        c = new_client()
        c.headers.update({k: v for k, v in client.headers.items() if k == "x-forwarded-for"})
        c.cookies.update(client.cookies)
        clients.append(c)
    bodies = [{"new_email": new, "code": wrong_guess(code)}] * GUESSES

    statuses = in_parallel(clients, "/api/account/email/verify", bodies)

    assert statuses.count(400) == 4, statuses
    assert statuses.count(423) == GUESSES - 4, statuses
    assert latest_row(new).attempts == 5
    r = client.post("/api/account/email/verify", json={"new_email": new, "code": code})
    assert r.status_code == 423
    assert client.get("/api/auth/session").json()["user"]["email"] != new


def test_a_right_code_sent_twice_at_once_signs_in_once() -> None:
    email = fresh("sam")
    sign_up(new_client(), email, FakeAuthenticator())
    code = send_code(new_client(), email)
    clients = [new_client() for _ in range(4)]
    statuses = in_parallel(
        clients, "/api/auth/otp/verify", [{"email": email, "code": code}] * len(clients)
    )
    assert statuses.count(200) == 1, statuses


def test_one_passkey_challenge_answers_one_check_however_many_arrive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sibling (invariant 32): a session's passkey challenge is consumed once, so one signed
    answer sent several times at once passes once."""
    real = webauthn_svc.verify_authentication_response

    def slow(**kwargs):
        time.sleep(0.05)
        return real(**kwargs)

    monkeypatch.setattr(webauthn_svc, "verify_authentication_response", slow)
    client = new_client()
    authenticator = FakeAuthenticator()
    sign_up(client, fresh("lee"), authenticator)
    r = client.post("/api/security/passkeys/assert/options", json={"purpose": "unlock"})
    # A synced passkey (iCloud Keychain, Google Password Manager) reports a sign count of 0, so
    # the counter cannot catch a replay: only the challenge being used once does.
    for cred_id in authenticator.counts:
        authenticator.counts[cred_id] = -1
    credential = authenticator.assert_(r.json()["options"])
    clients = []
    for _ in range(4):
        c = new_client()
        c.headers["x-forwarded-for"] = client.headers["x-forwarded-for"]
        c.cookies.update(client.cookies)
        # A background call never touches the session row, so nothing else serializes them.
        c.headers["x-qash-background"] = "1"
        clients.append(c)
    statuses = in_parallel(
        clients,
        "/api/security/passkeys/assert/verify",
        [{"credential": credential}] * len(clients),
    )
    assert statuses.count(200) == 1, statuses
