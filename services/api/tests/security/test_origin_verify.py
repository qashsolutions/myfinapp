"""Only CloudFront may call the API in production (security/origin_verify.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.cli import jobs_loop
from app.config import Settings, get_settings
from app.main import create_app
from app.security.client import client_ip


def test_requests_without_the_header_are_refused(prod_settings: None) -> None:
    with TestClient(create_app()) as c:
        r = c.get("/api/auth/session")
        assert r.status_code == 403
        assert r.json() == {"detail": "forbidden"}
        assert r.headers["cache-control"] == "no-store"
        wrong = c.get("/api/auth/session", headers={"X-Origin-Verify": "nope"})
        assert wrong.status_code == 403
        # The load balancer's health checks stay open.
        assert c.get("/health").status_code == 200
        ok = c.get("/api/auth/session", headers={"X-Origin-Verify": "test-origin-verify"})
        assert ok.status_code == 200


def test_off_when_not_set(client: TestClient) -> None:
    assert client.get("/api/auth/session").status_code == 200


def test_production_requires_it(monkeypatch: pytest.MonkeyPatch, prod_settings: None) -> None:
    monkeypatch.delenv("STACKD_ORIGIN_VERIFY")
    with pytest.raises(ValueError, match="STACKD_ORIGIN_VERIFY"):
        Settings()  # type: ignore[call-arg]
    monkeypatch.setenv("STACKD_ORIGIN_VERIFY", "")
    with pytest.raises(ValueError, match="STACKD_ORIGIN_VERIFY"):
        Settings()  # type: ignore[call-arg]


class _Req:
    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = headers
        self.client = None


def test_client_ip_prefers_cloudfronts_viewer_address(prod_settings: None) -> None:
    assert get_settings().trust_proxy_headers
    spoofed = {"x-forwarded-for": "6.6.6.6, 203.0.113.9"}
    assert client_ip(_Req(spoofed)) == "6.6.6.6"  # fallback only: no CloudFront header
    assert (
        client_ip(_Req({**spoofed, "cloudfront-viewer-address": "203.0.113.9:51234"}))
        == "203.0.113.9"
    )
    assert client_ip(_Req({"cloudfront-viewer-address": "2001:db8::1:443"})) == "2001:db8::1"


def test_jobs_loop_runs_daily_jobs_once_and_survives_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.cli as cli

    calls: list[str] = []

    def record(name: str, fail: bool = False):
        def job() -> int:
            calls.append(name)
            if fail:
                raise RuntimeError("boom")
            return 0

        job.__name__ = name
        return job

    monkeypatch.setattr(cli, "dispatch_alerts", record("dispatch", fail=True))
    for name in (
        "purge_deleted",
        "purge_backups",
        "revoke_links",
        "purge_audit",
        "purge_expired",
        "plan_lifecycle",
        "settle_deletions",
    ):
        monkeypatch.setattr(cli, name, record(name))
    slept: list[float] = []
    assert jobs_loop(rounds=3, sleep=slept.append) == 0
    assert calls.count("dispatch") == 3  # every minute, even after it failed
    for name in ("purge_deleted", "purge_backups", "revoke_links", "purge_audit", "purge_expired"):
        assert calls.count(name) == 1  # daily: at start-up only within a few minutes
    assert len(slept) == 2 and all(0 <= s <= 60 for s in slept)


def test_jobs_loop_retries_a_failed_daily_job_after_ten_minutes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.cli as cli

    now = [0.0]
    calls: list[str] = []
    fail_first = {"purge_deleted": True}

    def record(name: str):
        def job() -> int:
            calls.append(name)
            if fail_first.pop(name, False):
                raise RuntimeError("tables not migrated yet")
            return 0

        job.__name__ = name
        return job

    monkeypatch.setattr(cli, "dispatch_alerts", record("dispatch"))
    for name in (
        "purge_deleted",
        "purge_backups",
        "revoke_links",
        "purge_audit",
        "purge_expired",
        "plan_lifecycle",
        "settle_deletions",
    ):
        monkeypatch.setattr(cli, name, record(name))

    def sleep(seconds: float) -> None:
        now[0] += 60.0  # one round a minute

    assert jobs_loop(rounds=12, sleep=sleep, clock=lambda: now[0]) == 0
    assert calls.count("dispatch") == 12
    assert calls.count("purge_deleted") == 2  # failed at 0:00, retried at 0:10, then daily
    assert calls.count("purge_backups") == 1
