from fastapi.testclient import TestClient

from app.main import create_app


def test_json_responses_carry_hardening_headers(client: TestClient) -> None:
    h = client.get("/health").headers
    assert h["cache-control"] == "no-store"
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["x-frame-options"] == "DENY"
    assert h["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert "strict-transport-security" not in h  # only behind TLS, i.e. prod


def test_docs_page_is_exempt_from_csp_only(client: TestClient) -> None:
    h = client.get("/docs").headers
    assert "content-security-policy" not in h
    assert h["x-content-type-options"] == "nosniff"


def test_hsts_in_prod(prod_settings: None) -> None:
    with TestClient(create_app()) as c:
        h = c.get("/health").headers
    assert h["strict-transport-security"] == "max-age=31536000; includeSubDomains"
