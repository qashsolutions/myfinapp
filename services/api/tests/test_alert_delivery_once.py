"""Invariant 33: what was sent is recorded as it goes. The dispatcher used to commit once at the
end of the run, so one person's failure rolled back every log row and the next minute sent
everyone's pushes and emails again."""

from __future__ import annotations

import uuid
from contextlib import suppress
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs import alert_dispatch, weekly_recap
from app.jobs.alert_dispatch import dispatch_due
from app.models.notification import AlertSchedule, NotificationLog
from app.services import alerts, ops_alerts, push
from tests.auth_flow import new_client, outbox, sign_up
from tests.test_notifications import FakeBrowser
from tests.webauthn_fake import FakeAuthenticator

NOW = datetime(2026, 9, 3, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    push.transport_override = None
    yield
    push.transport_override = None


class Browsers:
    """One fake push service for several people: each request goes to its endpoint's browser."""

    def __init__(self) -> None:
        self.by_endpoint: dict[str, FakeBrowser] = {}

    def add(self) -> FakeBrowser:
        b = FakeBrowser()
        self.by_endpoint[b.endpoint] = b
        return b

    def transport(self) -> httpx2.MockTransport:
        handlers = {e: b.transport() for e, b in self.by_endpoint.items()}

        def handle(request: httpx2.Request) -> httpx2.Response:
            return handlers[str(request.url)].handle_request(request)

        return httpx2.MockTransport(handle)


def person(browsers: Browsers, key: str) -> tuple[str, FakeBrowser]:
    client = new_client()
    sign_up(client, f"p+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    user_id = client.get("/api/auth/session").json()["user"]["id"]
    browser = browsers.add()
    push.transport_override = browsers.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={"settings": {"quiet_start": "00:00", "quiet_end": "00:00", "daily_max": 0}},
    )
    r = client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (NOW - timedelta(minutes=5)).isoformat(),
                    "type": "upcoming_expense",
                    "dedupe_key": key,
                }
            ]
        },
    )
    assert r.status_code == 200, r.text
    return user_id, browser


def test_a_failure_for_one_person_never_sends_the_others_again(monkeypatch) -> None:
    browsers = Browsers()
    a = person(browsers, f"upcoming:{uuid.uuid4().hex[:8]}")
    b = person(browsers, f"upcoming:{uuid.uuid4().hex[:8]}")
    push.transport_override = browsers.transport()
    # The dispatcher goes person by person in id order: make the second one fail.
    (first, first_browser), (second, second_browser) = sorted([a, b])
    real = alert_dispatch.prefs_for
    reported: list[str] = []

    def failing(db, user_id):
        if str(user_id) == second:
            raise RuntimeError("database hiccup")
        return real(db, user_id)

    monkeypatch.setattr(alert_dispatch, "prefs_for", failing)
    monkeypatch.setattr(ops_alerts, "report", lambda kind, where, exc, **_: reported.append(kind))
    with get_session_factory()() as s, suppress(RuntimeError):
        dispatch_due(s, now=NOW)  # the fix never raises: the failure is reported
    assert len(first_browser.received) == 1 and second_browser.received == []

    monkeypatch.setattr(alert_dispatch, "prefs_for", real)
    with get_session_factory()() as s:
        dispatch_due(s, now=NOW + timedelta(minutes=1))
    assert len(first_browser.received) == 1  # not again
    assert len(second_browser.received) == 1  # and the second one's goes the next minute
    assert reported == ["alert_dispatch_failed"]


def test_a_summary_row_whose_key_was_sent_is_done_not_a_failed_commit() -> None:
    browsers = Browsers()
    key = f"milestone:{uuid.uuid4().hex[:8]}"
    user_id, browser = person(browsers, f"upcoming:{uuid.uuid4().hex[:8]}")
    push.transport_override = browsers.transport()
    with get_session_factory()() as s:
        uid = uuid.UUID(user_id)
        s.add(
            NotificationLog(
                user_id=uid, type="milestone_reached", dedupe_key=key, sent_at=NOW, channel="push"
            )
        )
        row = alerts.enqueue(s, uid, "upcoming_expense", NOW, f"other:{key}", from_device=True)
        s.flush()
        row.dedupe_key = key  # as if logged after it was rolled into the summary
        row.type = "milestone_reached"
        row.status = "summary"
        row.due_at = NOW - timedelta(minutes=1)
        s.commit()
    with get_session_factory()() as s:
        dispatch_due(s, now=NOW)
    with get_session_factory()() as s:
        status = s.scalar(
            select(AlertSchedule.status).where(
                AlertSchedule.user_id == uid, AlertSchedule.dedupe_key == key
            )
        )
    assert status == "sent"
    # Only the ordinary push went; no summary for a key already sent
    assert len(browser.received) == 1
    assert not browser.received[0]["tag"].startswith("summary:")


def test_one_bad_recap_preference_never_stops_the_others(monkeypatch) -> None:
    reported: list[str] = []
    monkeypatch.setattr(ops_alerts, "report", lambda kind, where, exc, **_: reported.append(kind))
    real = weekly_recap.next_occurrence
    calls = {"n": 0}

    def flaky(now_local, weekday, clock):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("bad preference")
        return real(now_local, weekday, clock)

    clients = []
    for _ in range(2):
        c = new_client()
        sign_up(c, f"r+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
        r = c.put(
            "/api/notifications/settings",
            json={"prefs": {"weekly_recap": {"enabled": True, "channel": "email"}}},
        )
        assert r.status_code == 200, r.text
        clients.append(c)
    monkeypatch.setattr(weekly_recap, "next_occurrence", flaky)
    with get_session_factory()() as s:
        made = weekly_recap.enqueue_due(s, now=NOW)
    assert reported == ["recap_enqueue_failed"]
    assert made >= 1
    for c in clients:  # leave no recap preference behind for the other tests' counts
        c.put("/api/notifications/settings", json={"prefs": {"weekly_recap": {"enabled": False}}})


def test_a_skipped_alert_comes_back_when_its_type_is_turned_on_again() -> None:
    """Invariant 34: a key skipped while its type was off is scheduled again for a time still
    ahead; a key that was sent never is."""
    browsers = Browsers()
    key = f"shortfall:{uuid.uuid4().hex[:8]}"
    client = new_client()
    sign_up(client, f"k+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    browser = browsers.add()
    push.transport_override = browsers.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={
            "settings": {"quiet_start": "00:00", "quiet_end": "00:00", "daily_max": 0},
            "prefs": {"upcoming_expense": {"enabled": False}},
        },
    )
    now = datetime.now(UTC)

    def schedule(due: datetime) -> None:
        item = {"due_at": due.isoformat(), "type": "upcoming_expense", "dedupe_key": key}
        assert client.put("/api/alerts/schedule", json={"items": [item]}).status_code == 200

    schedule(now - timedelta(minutes=5))
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert browser.received == []  # off: skipped

    client.put(
        "/api/notifications/settings", json={"prefs": {"upcoming_expense": {"enabled": True}}}
    )
    schedule(now + timedelta(hours=1))
    with get_session_factory()() as s:
        dispatch_due(s, now=now + timedelta(hours=1, minutes=1))
    assert [m["tag"] for m in browser.received] == [key]

    schedule(now + timedelta(hours=2))  # sent: never again
    with get_session_factory()() as s:
        dispatch_due(s, now=now + timedelta(hours=2, minutes=1))
    assert len(browser.received) == 1
