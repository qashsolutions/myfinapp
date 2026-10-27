"""Errors that need a person email the admins: fixed fields only, at most one an hour per kind
and place, and never a failure of their own (October 25, 2026)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.services import ops_alerts
from tests.auth_flow import outbox

SECRET = "rent 1200.00 for jo@example.com"  # what an error message might quote


@pytest.fixture(autouse=True)
def _admins(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(get_settings(), "admin_emails", ["ops@example.com"])
    ops_alerts.reset_for_tests()
    outbox().clear()
    yield
    ops_alerts.reset_for_tests()


def _broken_app(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The real app, with one real route made to fail the way a bug would."""
    import app.routers.public_plans as public_plans
    from app.main import create_app

    def boom(_db):
        raise ValueError(SECRET)

    monkeypatch.setattr(public_plans, "founding_left", boom)
    return TestClient(create_app(), raise_server_exceptions=False)


def test_an_unhandled_api_error_emails_the_admins_without_what_it_was_working_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _broken_app(monkeypatch)
    assert client.get("/api/public/plans/founding").status_code == 500
    [mail] = outbox()
    assert mail.to == "ops@example.com"
    assert mail.subject == "Qash error: api_error in GET /api/public/plans/founding"
    assert "Error: ValueError at app/" in mail.text
    assert "1200" not in mail.text and "@example.com" not in mail.text


def test_one_email_an_hour_per_kind_and_place_then_how_many_since() -> None:
    now = [1000.0]
    exc = RuntimeError(SECRET)
    assert ops_alerts.report("job_failed", "purge_deleted", exc, clock=lambda: now[0]) is True
    assert ops_alerts.report("job_failed", "purge_deleted", exc, clock=lambda: now[0]) is False
    assert ops_alerts.report("job_failed", "revoke_links", exc, clock=lambda: now[0]) is True
    now[0] += 3601
    assert ops_alerts.report("job_failed", "purge_deleted", exc, clock=lambda: now[0]) is True
    assert [m.subject for m in outbox()] == [
        "Qash error: job_failed in purge_deleted",
        "Qash error: job_failed in revoke_links",
        "Qash error: job_failed in purge_deleted",
    ]
    assert "Seen 2 times" in outbox()[-1].text
    assert all(SECRET not in m.text for m in outbox())


def test_a_job_that_fails_in_the_loop_emails_its_name(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.cli as cli

    def named(name: str, fail: bool = False):
        def job() -> int:
            if fail:
                raise RuntimeError(SECRET)
            return 0

        job.__name__ = name
        return job

    monkeypatch.setattr(cli, "dispatch_alerts", named("dispatch_alerts"))
    for name in (
        "purge_backups",
        "revoke_links",
        "purge_audit",
        "purge_expired",
        "plan_lifecycle",
        "settle_deletions",
    ):
        monkeypatch.setattr(cli, name, named(name))
    monkeypatch.setattr(cli, "purge_deleted", named("purge_deleted", fail=True))
    assert cli.jobs_loop(rounds=1, sleep=lambda _s: None) == 0
    assert [m.subject for m in outbox()] == ["Qash error: job_failed in purge_deleted"]


def test_an_alert_that_cannot_be_sent_never_becomes_a_second_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Down:
        def send(self, _m) -> None:
            raise OSError("smtp down")

    monkeypatch.setattr(ops_alerts, "get_sender", lambda: Down())
    assert ops_alerts.report("api_error", "GET /x", RuntimeError("x")) is False


def test_an_id_in_the_path_never_reaches_the_email() -> None:
    scope = {"method": "POST", "path": "/api/linking/3f2a9c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b/sync"}
    assert ops_alerts.route_of(scope) == "POST /api/linking/{id}/sync"


def test_a_failure_noticed_without_an_exception_is_reported_too() -> None:
    assert ops_alerts.report("deletion_billing_pending", "soft_delete", None) is True
    [mail] = outbox()
    assert mail.subject == "Qash error: deletion_billing_pending in soft_delete"
    assert "Error: none raised" in mail.text
