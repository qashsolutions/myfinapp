"""Helpers shared by the auth tests: drive the real endpoints like the app would."""

from __future__ import annotations

import random
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


def new_client(user_agent: str = IPHONE_UA) -> TestClient:
    c = TestClient(create_app())
    c.headers["user-agent"] = user_agent
    # A distinct client IP per device, so per-IP rate limits behave as they would in production.
    c.headers["x-forwarded-for"] = f"203.0.{random.randint(0, 255)}.{random.randint(1, 254)}"
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
