"""Every route is guarded the way the conventions say (CLAUDE.md "Security conventions"):

- a request without a session gets 401 everywhere except the public surface;
- a state-changing request from another origin gets 403 `cross_site` everywhere except the
  website's public routes and the Stripe webhook, which have their own checks.

New routes are covered as soon as they exist: the table comes from the app itself.
"""

import pytest

from app.main import create_app
from tests.auth_flow import new_client

PUBLIC = {
    ("GET", "/health"),
    ("GET", "/health/ready"),
    ("POST", "/api/auth/otp/send"),
    ("POST", "/api/auth/otp/verify"),
    ("POST", "/api/auth/passkey/options"),  # passkey sign-in: nobody is signed in yet
    ("POST", "/api/auth/passkey/verify"),
    ("GET", "/api/auth/session"),
    ("POST", "/api/auth/link/start"),  # link with your phone: the computer isn't signed in
    ("GET", "/api/auth/link/status"),
    ("POST", "/api/public/account/delete/send"),
    ("POST", "/api/public/account/delete/verify"),
    ("GET", "/api/public/plans/founding"),  # the website's "places left" counter
    ("POST", "/api/webhooks/stripe"),
    ("POST", "/api/webhooks/apple"),
    ("POST", "/api/webhooks/google"),
    ("POST", "/api/webhooks/plaid"),
}
CROSS_SITE_EXEMPT = {
    "/api/public/account/delete/send",
    "/api/public/account/delete/verify",
    "/api/webhooks/stripe",
    "/api/webhooks/apple",
    "/api/webhooks/google",
    "/api/webhooks/plaid",
}


def _routes() -> list[tuple[str, str]]:
    """Every operation the API publishes, from its own OpenAPI document."""
    paths = create_app().openapi()["paths"]
    return sorted(
        (method.upper(), path)
        for path, operations in paths.items()
        if path.startswith(("/api", "/health"))
        for method in operations
        if method.upper() not in {"HEAD", "OPTIONS"}
    )


def _concrete(path: str) -> str:
    return (
        path.replace("{group_id}", "00000000-0000-0000-0000-000000000001")
        .replace("{user_id}", "00000000-0000-0000-0000-000000000002")
        .replace("{session_id}", "00000000-0000-0000-0000-000000000003")
        .replace("{passkey_id}", "00000000-0000-0000-0000-000000000004")
        .replace("{kind}", "jars")
    )


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    pass


def test_the_route_table_is_the_one_we_expect() -> None:
    assert len(_routes()) >= 50, _routes()
    for method, path in PUBLIC:
        assert (method, path) in _routes(), f"public route missing: {method} {path}"


@pytest.mark.parametrize(("method", "path"), _routes())
def test_no_session_means_401_unless_public(method: str, path: str) -> None:
    client = new_client()
    r = client.request(method, _concrete(path), json={})
    if (method, path) in PUBLIC:
        assert r.status_code != 401, f"{method} {path} should not need a session: {r.status_code}"
    else:
        assert r.status_code == 401, f"{method} {path}: {r.status_code} {r.text[:120]}"


@pytest.mark.parametrize(
    ("method", "path"), [(m, p) for m, p in _routes() if m != "GET" and p not in CROSS_SITE_EXEMPT]
)
def test_cross_site_writes_are_refused_before_anything_else(method: str, path: str) -> None:
    client = new_client()
    client.headers["origin"] = "https://evil.example"
    r = client.request(method, _concrete(path), json={})
    assert r.status_code == 403 and r.json()["detail"] == "cross_site", (
        f"{method} {path}: {r.status_code} {r.text[:120]}"
    )
