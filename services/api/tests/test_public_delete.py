"""Deleting an account from the website: a code to the address, then the same soft delete as
in-app deletion. Unknown addresses get the same answer and no email; only the site's origin
is admitted cross-origin."""

import re
import uuid

import pytest

from tests.auth_flow import new_client, outbox, send_code, sign_up
from tests.webauthn_fake import FakeAuthenticator

SITE = "http://localhost:4321"
CODE = re.compile(r"page: (\d{6})")


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_public_deletion_by_email_code() -> None:
    client = new_client()
    email = f"maya+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(client, email, FakeAuthenticator())
    outbox().clear()
    site = new_client()
    site.headers["origin"] = SITE

    # Unknown address: same answer, no email
    r = site.post("/api/public/account/delete/send", json={"email": "nobody@example.com"})
    assert r.status_code == 200 and r.json()["sent"] is True
    assert outbox() == []

    r = site.post("/api/public/account/delete/send", json={"email": email.upper()})
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == SITE
    assert [m.to for m in outbox()] == [email]
    message = outbox()[-1]
    assert "delet" in message.subject.lower()
    code = CODE.search(message.text).group(1)
    # In the fragment and encoded (a "+" in the address survives), never in the query string
    encoded = email.replace("+", "%2B").replace("@", "%40")
    assert f"{SITE}/delete-account#email={encoded}&code={code}" in message.text
    assert "delete-account?" not in message.text

    r = site.post("/api/public/account/delete/verify", json={"email": email, "code": "000000"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "wrong_code"
    assert client.get("/api/auth/session").json()["authenticated"] is True

    r = site.post("/api/public/account/delete/verify", json={"email": email, "code": code})
    assert r.status_code == 204, r.text
    assert client.get("/api/auth/session").json()["authenticated"] is False
    assert any("delet" in m.subject.lower() for m in outbox()[1:])  # the always-on alert
    # The code is spent and the account is gone from the public route's view
    r = site.post("/api/public/account/delete/verify", json={"email": email, "code": code})
    assert r.status_code == 400


def test_a_sign_in_code_never_deletes_the_account() -> None:
    client = new_client()
    email = f"maya+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(client, email, FakeAuthenticator())
    signin_code = send_code(new_client(), email)
    site = new_client()
    site.headers["origin"] = SITE
    r = site.post("/api/public/account/delete/verify", json={"email": email, "code": signin_code})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "wrong_code"
    assert client.get("/api/auth/session").json()["authenticated"] is True


def test_only_the_site_origin_is_admitted() -> None:
    other = new_client()
    other.headers["origin"] = "https://evil.example"
    r = other.post("/api/public/account/delete/send", json={"email": "x@example.com"})
    assert r.status_code == 403 and r.json()["detail"] == "cross_site"
    assert "access-control-allow-origin" not in r.headers

    preflight = new_client()
    r = preflight.options(
        "/api/public/account/delete/send",
        headers={"origin": SITE, "access-control-request-method": "POST"},
    )
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == SITE
    assert "POST" in r.headers["access-control-allow-methods"]
    r = preflight.options(
        "/api/public/account/delete/send",
        headers={"origin": "https://evil.example", "access-control-request-method": "POST"},
    )
    assert r.status_code == 204 and "access-control-allow-origin" not in r.headers

    # The site origin gets nothing outside /api/public/
    site = new_client()
    site.headers["origin"] = SITE
    assert site.get("/api/auth/session").status_code == 200
    assert "access-control-allow-origin" not in site.get("/api/auth/session").headers
    assert site.post("/api/auth/signout").status_code == 403


def _answers(email: str) -> list[tuple[int, object, str | None]]:
    """Every answer the public routes give for one address: verify before any send, send, a
    resend too soon, then wrong codes through the lockout and one after it, and a send while
    locked."""
    site = new_client()
    site.headers["origin"] = SITE
    out = []

    def keep(r):
        body = r.json() if r.content else None
        out.append((r.status_code, body, r.headers.get("retry-after")))

    verify = {"email": email, "code": "000000"}
    keep(site.post("/api/public/account/delete/verify", json=verify))
    keep(site.post("/api/public/account/delete/send", json={"email": email}))
    keep(site.post("/api/public/account/delete/send", json={"email": email}))
    for _ in range(6):
        keep(site.post("/api/public/account/delete/verify", json=verify))
    keep(site.post("/api/public/account/delete/send", json={"email": email}))
    return out


def test_public_routes_answer_the_same_whether_or_not_an_account_exists() -> None:
    """No account oracle (CLAUDE.md "Public routes answer the same way whether or not an
    account exists"): the same status, body and headers for a real and an unknown address,
    through wrong codes, the lockout and a send while locked."""
    real = f"maya+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(new_client(), real, FakeAuthenticator())
    unknown = f"nobody+{uuid.uuid4().hex[:6]}@example.com"
    outbox().clear()
    real_answers = _answers(real)
    unknown_answers = _answers(unknown)
    assert real_answers == unknown_answers
    # The real owner still got the code and the lockout alert; the unknown address nothing
    assert {m.to for m in outbox()} == {real}
    assert any("wrong codes" in m.subject for m in outbox())


def test_send_does_the_same_work_for_an_unknown_address() -> None:
    """The time a send takes says nothing either: a code row is written for any address, and
    the email goes after the answer (a background task), not inside it."""
    from sqlalchemy import func, select

    from app.db import get_session_factory
    from app.models.otp_code import OtpCode

    unknown = f"nobody+{uuid.uuid4().hex[:6]}@example.com"
    site = new_client()
    site.headers["origin"] = SITE
    assert site.post("/api/public/account/delete/send", json={"email": unknown}).status_code == 200
    with get_session_factory()() as db:
        n = db.scalar(select(func.count()).select_from(OtpCode).where(OtpCode.email == unknown))
    assert n == 1
