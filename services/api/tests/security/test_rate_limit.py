import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app.config import get_settings
from app.db import get_session_factory
from app.security.client import client_ip
from app.security.rate_limit import LIMITS, Limit, hit, rate_limited, window_start

T0 = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)  # on a 15-minute boundary


def test_window_start_is_epoch_aligned() -> None:
    assert window_start(T0 + timedelta(minutes=14, seconds=59), timedelta(minutes=15)) == T0
    assert window_start(T0 + timedelta(minutes=15), timedelta(minutes=15)) == T0 + timedelta(
        minutes=15
    )


def test_blocks_after_max_hits_then_resets(migrated: Engine) -> None:
    limit = Limit("otp_send", 3, timedelta(minutes=15))
    key = f"203.0.113.{uuid.uuid4().int % 256}-{uuid.uuid4()}"
    with get_session_factory()() as s, s.begin():
        decisions = [hit(s, limit, key, now=T0 + timedelta(seconds=i)) for i in range(4)]
        later = hit(s, limit, key, now=T0 + timedelta(minutes=15))
    assert [d.allowed for d in decisions] == [True, True, True, False]
    assert [d.remaining for d in decisions] == [2, 1, 0, 0]
    assert decisions[3].hits == 4
    assert decisions[3].retry_after == 15 * 60 - 3  # window ends at 12:15, now is 12:00:03
    assert later.allowed and later.hits == 1


def test_keys_are_independent(migrated: Engine) -> None:
    limit = Limit("sign_in", 1, timedelta(minutes=15))
    a, b = f"a-{uuid.uuid4()}", f"b-{uuid.uuid4()}"
    with get_session_factory()() as s, s.begin():
        assert hit(s, limit, a, now=T0).allowed
        assert not hit(s, limit, a, now=T0).allowed
        assert hit(s, limit, b, now=T0).allowed


def test_stored_key_is_a_pseudonym(migrated: Engine) -> None:
    raw = f"198.51.100.7-{uuid.uuid4()}"
    with get_session_factory()() as s, s.begin():
        hit(s, Limit("upload", 30, timedelta(hours=1)), raw, now=T0)
        keys = s.execute(
            text("SELECT key FROM rate_limit_buckets WHERE scope = 'upload'")
        ).scalars()
        keys = list(keys)
    assert raw not in keys
    assert all(len(k) == 32 and k == k.lower() for k in keys)


def test_dependency_answers_429_with_retry_after(migrated: Engine) -> None:
    app = FastAPI()
    guard = rate_limited("otp_send", key=lambda r: r.headers["x-test-key"])

    @app.post("/otp", dependencies=[Depends(guard)])
    def send_code() -> dict[str, str]:
        return {"sent": "ok"}

    key = str(uuid.uuid4())
    with TestClient(app) as c:
        for _ in range(LIMITS["otp_send"].max_hits):
            assert c.post("/otp", headers={"x-test-key": key}).status_code == 200
        r = c.post("/otp", headers={"x-test-key": key})
    assert r.status_code == 429
    assert r.json() == {"detail": "rate_limited"}
    assert int(r.headers["retry-after"]) >= 1


def _request(client_host: str, forwarded: str | None) -> Request:
    headers = [(b"x-forwarded-for", forwarded.encode())] if forwarded else []
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": headers,
            "client": (client_host, 1234),
            "server": ("api", 80),
            "scheme": "http",
        }
    )


def test_client_ip_ignores_forwarded_unless_trusted(monkeypatch: pytest.MonkeyPatch) -> None:
    req = _request("10.0.0.2", "203.0.113.9, 10.0.0.1")
    monkeypatch.setattr(get_settings(), "trust_proxy_headers", False)
    assert client_ip(req) == "10.0.0.2"
    monkeypatch.setattr(get_settings(), "trust_proxy_headers", True)
    assert client_ip(req) == "203.0.113.9"
    assert client_ip(_request("10.0.0.2", None)) == "10.0.0.2"
