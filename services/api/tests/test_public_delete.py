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


def test_the_verify_answer_never_says_whether_an_account_exists() -> None:
    """The route's promise (module docstring, invariant 16's spirit): unknown addresses get the
    same answer. The error body must match field for field — a different code or a missing
    `attempts_left` makes the page a yes/no oracle for any email address."""
    client = new_client()
    email = f"maya+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(client, email, FakeAuthenticator())
    site = new_client()
    site.headers["origin"] = SITE
    ghost = f"ghost+{uuid.uuid4().hex[:6]}@example.com"

    # Before any code was asked for: the same answer for both
    real = site.post("/api/public/account/delete/verify", json={"email": email, "code": "000000"})
    fake = site.post("/api/public/account/delete/verify", json={"email": ghost, "code": "000000"})
    assert (fake.status_code, fake.json()) == (real.status_code, real.json())

    # After asking for a code: still the same answer (the ghost gets a code row, never an email)
    outbox().clear()
    site.post("/api/public/account/delete/send", json={"email": email})
    site.post("/api/public/account/delete/send", json={"email": ghost})
    assert [m.to for m in outbox()] == [email]
    real = site.post("/api/public/account/delete/verify", json={"email": email, "code": "000000"})
    fake = site.post("/api/public/account/delete/verify", json={"email": ghost, "code": "000000"})
    assert (fake.status_code, fake.json()) == (real.status_code, real.json())
    assert client.get("/api/auth/session").json()["authenticated"] is True


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
