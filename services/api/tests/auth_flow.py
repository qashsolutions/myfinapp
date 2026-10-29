"""Helpers shared by the auth tests: drive the real endpoints like the app would."""

from __future__ import annotations

import itertools
import re

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.email import MemoryEmailSender, get_sender
from tests.webauthn_fake import FakeAuthenticator

IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 20_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/20.0 Mobile/15E148 Safari/604.1"
)
MAC_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)


def outbox() -> list:
    sender = get_sender()
    assert isinstance(sender, MemoryEmailSender)
    return sender.outbox


# Every client in a test session gets an address no other client has had, each on its own /24.
# They used to be random 203.0.x.y: rate-limit buckets outlive a test, so a test that fills an
# IP's limit on purpose (20 code checks, 5 sends, 10 passkey sign-ins) left that address blocked
# for its window, and a later test that drew the same address failed with rate_limited.
_CLIENT_NUMBERS = itertools.count(1)


def next_client_ip() -> str:
    """10.a.b.1 with (a, b) counting up: 65,535 distinct /24 networks before any repeat, never
    the 203.0.113.x / 198.x addresses tests pick by hand."""
    n = next(_CLIENT_NUMBERS)
    assert n < 1 << 16, "more clients than distinct test addresses"
    return f"10.{n >> 8}.{n & 255}.1"


def new_client(user_agent: str = IPHONE_UA) -> TestClient:
    c = TestClient(create_app())
    c.headers["user-agent"] = user_agent
    # A distinct client IP per device, so per-IP rate limits behave as they would in production.
    c.headers["x-forwarded-for"] = next_client_ip()
    return c


def send_code(client: TestClient, email: str) -> str:
    before = len(outbox())
    r = client.post("/api/auth/otp/send", json={"email": email})
    assert r.status_code == 200, r.text
    assert len(outbox()) == before + 1
    match = re.search(r"\b(\d{6})\b", outbox()[-1].text)
    assert match, outbox()[-1].text
    return match.group(1)


def sign_in_with_code(client: TestClient, email: str, display_mode: str = "browser") -> dict:
    code = send_code(client, email)
    r = client.post(
        "/api/auth/otp/verify", json={"email": email, "code": code, "display_mode": display_mode}
    )
    assert r.status_code == 200, r.text
    assert "stackd_session" in r.cookies
    return r.json()


def register_passkey(
    client: TestClient, authenticator: FakeAuthenticator, label: str | None = None
) -> dict:
    r = client.post("/api/security/passkeys/register/options")
    assert r.status_code == 200, r.text
    credential = authenticator.register(r.json()["options"])
    body: dict = {"credential": credential}
    if label:
        body["label"] = label
    r = client.post("/api/security/passkeys/register/verify", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def assert_passkey(
    client: TestClient, authenticator: FakeAuthenticator, purpose: str = "unlock"
) -> dict:
    r = client.post("/api/security/passkeys/assert/options", json={"purpose": purpose})
    assert r.status_code == 200, r.text
    credential = authenticator.assert_(r.json()["options"])
    r = client.post("/api/security/passkeys/assert/verify", json={"credential": credential})
    assert r.status_code == 200, r.text
    return r.json()


def sign_up(client: TestClient, email: str, authenticator: FakeAuthenticator) -> dict:
    """Email code + passkey, the mandatory pair."""
    sign_in_with_code(client, email)
    register_passkey(client, authenticator)
    return client.get("/api/auth/session").json()
