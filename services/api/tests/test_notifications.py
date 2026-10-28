"""Notifications: settings, encrypted push subscriptions, the device's schedule, and the
dispatch job (quiet hours, daily max, dedupe) with a fake push service that decrypts what it
gets and checks that no amount or merchant is in it."""

import base64
import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import http_ece
import httpx2
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from app.db import get_session_factory
from app.jobs.alert_dispatch import dispatch_due
from app.jobs.weekly_recap import enqueue_due
from app.models.notification import AlertSchedule, NotificationLog, PushSubscription
from app.services import google_auth, push, push_native
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    push.transport_override = None
    push_native.transport_override = None
    yield
    push.transport_override = None
    push_native.transport_override = None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class FakeBrowser:
    """A push subscription whose private key we hold, so pushes can be decrypted and checked."""

    def __init__(self) -> None:
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}"
        self.received: list[dict] = []
        self.requests: list[httpx2.Request] = []
        self.status = 201

    def subscription(self) -> dict:
        raw = self.private.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return {
            "endpoint": self.endpoint,
            "keys": {"p256dh": b64url(raw), "auth": b64url(self.auth)},
        }

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            self.requests.append(request)
            body = http_ece.decrypt(
                request.content,
                private_key=self.private,
                auth_secret=self.auth,
                version="aes128gcm",
            )
            self.received.append(json.loads(body))
            return httpx2.Response(self.status)

        return httpx2.MockTransport(handle)


def member(name: str):
    client = new_client()
    sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    return client, client.get("/api/auth/session").json()["user"]["id"]


def test_settings_defaults_and_updates() -> None:
    client, _ = member("maya")
    r = client.get("/api/notifications/settings")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["settings"] == {
        "quiet_start": "21:00",
        "quiet_end": "08:00",
        "daily_max": 3,
        "paused_until": None,
        "timezone": "UTC",
    }
    assert data["prefs"]["upcoming_expense"] == {
        "enabled": True,
        "time_of_day": "09:00",
        "days": None,
        "lead_days": 3,
        "threshold": None,
        "channel": None,
        "delivery": None,
    }
    assert data["prefs"]["group_activity"]["enabled"] is False
    assert data["prefs"]["group_activity"]["delivery"] == "instant"
    assert data["prefs"]["milestone_reached"]["time_of_day"] == "19:00"
    assert data["push"] == {"available": True, "subscribed": False}

    r = client.put(
        "/api/notifications/settings",
        json={
            "prefs": {
                "group_activity": {"enabled": True},
                "challenge_checkin": {"time_of_day": "20:15"},
            },
            "settings": {
                "quiet_start": "22:00",
                "daily_max": 5,
                "timezone": "America/Chicago",
                "pause": "day",
            },
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["prefs"]["group_activity"]["enabled"] is True
    assert data["prefs"]["challenge_checkin"]["time_of_day"] == "20:15"
    assert data["settings"]["quiet_start"] == "22:00" and data["settings"]["daily_max"] == 5
    assert data["settings"]["timezone"] == "America/Chicago"
    assert data["settings"]["paused_until"] is not None
    assert (
        client.put(
            "/api/notifications/settings", json={"settings": {"quiet_end": "25:00"}}
        ).status_code
        == 422
    )
    # Pause until a day the person picks: up to a year ahead, with a time zone
    until = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0)
    r = client.put(
        "/api/notifications/settings", json={"settings": {"paused_until": until.isoformat()}}
    )
    assert r.status_code == 200, r.text
    assert datetime.fromisoformat(r.json()["settings"]["paused_until"]) == until
    too_far = datetime.now(UTC) + timedelta(days=400)
    for bad in (too_far.isoformat(), "2026-11-01T00:00:00"):
        assert (
            client.put(
                "/api/notifications/settings", json={"settings": {"paused_until": bad}}
            ).status_code
            == 422
        ), bad
    assert (
        client.put(
            "/api/notifications/settings", json={"settings": {"timezone": "Mars/Olympus"}}
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/notifications/settings", json={"prefs": {"marketing": {"enabled": True}}}
        ).status_code
        == 422
    )


def test_subscription_is_stored_encrypted_and_the_test_push_carries_no_money() -> None:
    client, user_id = member("maya")
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert (
        client.get("/api/notifications/push/key").json()["public_key"]
        == os.environ["STACKD_VAPID_PUBLIC_KEY"]
    )
    r = client.post(
        "/api/notifications/push", json={**browser.subscription(), "user_agent": "Safari on iPhone"}
    )
    assert r.status_code == 201, r.text
    assert client.get("/api/notifications/settings").json()["push"]["subscribed"] is True
    with get_session_factory()() as s:
        row = s.scalar(
            select(PushSubscription).where(PushSubscription.user_id == uuid.UUID(user_id))
        )
        assert row is not None
        assert browser.endpoint not in row.payload_encrypted
        assert push.decrypt_subscription(row.payload_encrypted)["endpoint"] == browser.endpoint

    r = client.post("/api/notifications/push/test")
    assert r.status_code == 200 and r.json() == {"delivered": 1}
    assert browser.received == [
        {
            "title": "Qash",
            "body": "Notifications are on",
            "tag": "test",
            "url": "/me/notifications",
        }
    ]
    request = browser.requests[0]
    assert request.headers["authorization"].startswith("vapid t=")
    assert request.headers["content-encoding"] == "aes128gcm"
    assert request.url.host == "fcm.googleapis.com"

    assert (
        client.post(
            "/api/notifications/push/unsubscribe", json={"endpoint": browser.endpoint}
        ).status_code
        == 204
    )
    assert client.get("/api/notifications/settings").json()["push"]["subscribed"] is False


def test_device_schedule_registers_dates_and_types_only() -> None:
    client, _ = member("maya")
    other, _ = member("dev")
    due = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    r = client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": due,
                    "type": "upcoming_expense",
                    "dedupe_key": "upcoming:rent:2026-10-25",
                },
                {"due_at": due, "type": "weekly_recap", "dedupe_key": "recap:2026-10-11"},
            ]
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["registered"] == 2
    labels = {i["dedupe_key"]: i["generic_label"] for i in r.json()["items"]}
    assert labels == {
        "upcoming:rent:2026-10-25": "An expected expense is coming up",
        "recap:2026-10-11": "Your weekly recap is ready",
    }
    assert "cents" not in r.text and "$" not in r.text
    # the list replaces the previous one; another user sees nothing
    r = client.put(
        "/api/alerts/schedule",
        json={"items": [{"due_at": due, "type": "weekly_recap", "dedupe_key": "recap:2026-10-11"}]},
    )
    assert [i["dedupe_key"] for i in r.json()["items"]] == ["recap:2026-10-11"]
    assert other.get("/api/alerts/schedule").json()["items"] == []
    assert (
        client.put(
            "/api/alerts/schedule",
            json={"items": [{"due_at": due, "type": "group_activity", "dedupe_key": "x"}]},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/alerts/schedule",
            json={"items": [{"due_at": due, "type": "weekly_recap", "dedupe_key": "has space"}]},
        ).status_code
        == 422
    )


def test_dispatch_sends_once_respects_quiet_hours_and_daily_max() -> None:
    client, user_id = member("maya")
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    # Awake all day, no cap for now
    client.put(
        "/api/notifications/settings",
        json={
            "settings": {
                "quiet_start": "00:00",
                "quiet_end": "00:00",
                "daily_max": 0,
                "timezone": "UTC",
            }
        },
    )
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    past = (now - timedelta(minutes=5)).isoformat()
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": past,
                    "type": "upcoming_expense",
                    "dedupe_key": "upcoming:rent:2026-10-25",
                },
                {
                    "due_at": (now + timedelta(days=1)).isoformat(),
                    "type": "weekly_recap",
                    "dedupe_key": "recap:2026-10-11",
                },
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=now)
    assert counts["sent"] == 1 and counts["waiting"] == 0
    assert browser.received == [
        {
            "title": "Qash",
            "body": "An expected expense is coming up",
            "tag": "upcoming:rent:2026-10-25",
            "url": "/forecast",
        }
    ]
    assert "cents" not in json.dumps(browser.received) and "$" not in json.dumps(browser.received)
    # Never twice, even if the device registers the same key again
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": past,
                    "type": "upcoming_expense",
                    "dedupe_key": "upcoming:rent:2026-10-25",
                }
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=now)
    assert counts["sent"] == 0 and len(browser.received) == 1
    with get_session_factory()() as s:
        assert (
            s.scalar(
                select(NotificationLog).where(
                    NotificationLog.dedupe_key == "upcoming:rent:2026-10-25"
                )
            )
            is not None
        )

    # Quiet hours: 21:00–08:00 UTC; at 23:00 the alert is deferred to 08:00 next day
    client.put(
        "/api/notifications/settings",
        json={"settings": {"quiet_start": "21:00", "quiet_end": "08:00"}},
    )
    late = datetime(2026, 10, 10, 23, 0, tzinfo=UTC)
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (late - timedelta(minutes=1)).isoformat(),
                    "type": "shortfall_risk",
                    "dedupe_key": "shortfall:2026-10-25:18000",
                }
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=late)
        row = s.scalar(
            select(AlertSchedule).where(AlertSchedule.dedupe_key == "shortfall:2026-10-25:18000")
        )
        assert counts["deferred"] == 1 and row is not None and row.status == "deferred"
        assert row.due_at == datetime(2026, 10, 11, 8, 0, tzinfo=UTC)
    assert len(browser.received) == 1
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=datetime(2026, 10, 11, 8, 0, tzinfo=UTC))
    assert (
        counts["sent"] == 1
        and browser.received[-1]["body"] == "Your forecast shows a possible shortfall"
    )

    # Daily max 1: the second alert of the day rolls into tomorrow's summary
    client.put("/api/notifications/settings", json={"settings": {"daily_max": 1}})
    morning = datetime(2026, 10, 11, 9, 0, tzinfo=UTC)
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (morning - timedelta(minutes=1)).isoformat(),
                    "type": "goal_behind_pace",
                    "dedupe_key": "behind:trip:5",
                },
                {
                    "due_at": (morning - timedelta(minutes=1)).isoformat(),
                    "type": "milestone_reached",
                    "dedupe_key": "milestone:jar:starter",
                },
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=morning)
    assert counts["sent"] == 0 and counts["summary"] == 2  # one already went today at 08:00
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=datetime(2026, 10, 12, 8, 0, tzinfo=UTC))
    assert counts["summary"] == 2
    assert browser.received[-1]["body"] == "You have 2 updates waiting"
    with get_session_factory()() as s:
        logged = {
            r.dedupe_key: r.channel
            for r in s.scalars(
                select(NotificationLog).where(NotificationLog.user_id == uuid.UUID(user_id))
            )
        }
    assert logged["behind:trip:5"] == "summary" and logged["milestone:jar:starter"] == "summary"

    # A gone endpoint revokes the subscription
    browser.status = 410
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": past.replace("2026-10-10", "2026-10-13"),
                    "type": "weekly_recap",
                    "dedupe_key": "recap:2026-10-18",
                }
            ]
        },
    )
    client.put("/api/notifications/settings", json={"settings": {"daily_max": 0}})
    with get_session_factory()() as s:
        dispatch_due(s, now=datetime(2026, 10, 13, 12, 0, tzinfo=UTC))
    assert client.get("/api/notifications/settings").json()["push"]["subscribed"] is False


def test_daily_summary_holds_event_alerts_until_the_chosen_time() -> None:
    client, user_id = member("maya")
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    r = client.put(
        "/api/notifications/settings",
        json={
            "prefs": {
                "group_activity": {"enabled": True, "delivery": "daily", "time_of_day": "18:30"},
                "milestone_reached": {"delivery": "daily", "time_of_day": "18:30"},
            },
            "settings": {"daily_max": 0, "timezone": "America/Chicago"},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["prefs"]["group_activity"]["delivery"] == "daily"
    # Only the three event alerts can wait for a summary
    bad = client.put(
        "/api/notifications/settings",
        json={"prefs": {"upcoming_expense": {"delivery": "daily"}}},
    )
    assert bad.status_code == 422 and bad.json()["detail"] == "delivery_not_supported"

    noon = datetime(2026, 10, 10, 17, 0, tzinfo=UTC)  # 12:00 in Chicago
    due = (noon - timedelta(minutes=5)).isoformat()
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {"due_at": due, "type": "milestone_reached", "dedupe_key": "milestone:jar:half"},
                {"due_at": due, "type": "upcoming_expense", "dedupe_key": "upcoming:rent:x"},
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=noon)
        held = s.scalar(
            select(AlertSchedule).where(AlertSchedule.dedupe_key == "milestone:jar:half")
        )
        assert held is not None and held.status == "summary"
        assert held.due_at == datetime(2026, 10, 10, 23, 30, tzinfo=UTC)  # 18:30 Chicago
    # The bill reminder still goes at once; the milestone waits
    assert counts["sent"] == 1 and counts["summary"] == 1
    assert [p["tag"] for p in browser.received] == ["upcoming:rent:x"]

    with get_session_factory()() as s:
        dispatch_due(s, now=datetime(2026, 10, 10, 20, 0, tzinfo=UTC))
    assert len(browser.received) == 1
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=datetime(2026, 10, 10, 23, 30, tzinfo=UTC))
    assert counts["summary"] == 1
    assert browser.received[-1]["body"] == "You have 1 update waiting"
    assert browser.received[-1]["tag"] == "summary:2026-10-10"

    # Back to "as it happens": the next one goes straight out
    client.put(
        "/api/notifications/settings",
        json={"prefs": {"milestone_reached": {"delivery": "instant"}}},
    )
    later = datetime(2026, 10, 11, 17, 0, tzinfo=UTC)
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (later - timedelta(minutes=1)).isoformat(),
                    "type": "milestone_reached",
                    "dedupe_key": "milestone:jar:full",
                }
            ]
        },
    )
    with get_session_factory()() as s:
        counts = dispatch_due(s, now=later)
    assert counts["sent"] == 1 and browser.received[-1]["tag"] == "milestone:jar:full"
    assert uuid.UUID(user_id)


def test_group_join_schedules_group_activity_for_the_others() -> None:
    maya, maya_id = member("maya")
    dev, _ = member("dev")
    maya.put("/api/notifications/settings", json={"prefs": {"group_activity": {"enabled": True}}})
    grant_plan(maya_id, "private")
    group = maya.post("/api/groups", json={"name": "October", "month": "2026-10"}).json()
    assert dev.post("/api/groups/join", json={"code": group["invite_code"]}).status_code == 200
    items = maya.get("/api/alerts/schedule").json()["items"]
    assert [i["type"] for i in items] == ["group_activity"]
    assert items[0]["generic_label"] == "Something happened in your group"
    assert "Dev" not in json.dumps(items) and "@" not in json.dumps(items)


def test_a_deleted_account_gets_no_pushes_and_no_recap_email() -> None:
    """Invariant: a deleted account hears nothing more from us (October 28, 2026). Deleting
    revokes every push subscription (web and native tokens alike) and drops the alerts not yet
    sent; the dispatcher and the recap scheduler skip deleted accounts even if a row slips in
    (a group join enqueues for every member)."""
    client, user_id = member("gone")
    uid = uuid.UUID(user_id)
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={
            "settings": {"quiet_start": "00:00", "quiet_end": "00:00", "timezone": "UTC"},
            "prefs": {"weekly_recap": {"channel": "both", "days": "6", "time_of_day": "09:00"}},
        },
    )
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    items = [
        {
            "due_at": (now - timedelta(minutes=5)).isoformat(),
            "type": "upcoming_expense",
            "dedupe_key": "upcoming:rent:2026-10-25",
        },
    ]
    assert client.put("/api/alerts/schedule", json={"items": items}).status_code == 200
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code == 204
    with get_session_factory()() as s:
        subs = s.scalars(select(PushSubscription).where(PushSubscription.user_id == uid)).all()
        assert subs and all(sub.revoked_at is not None for sub in subs)
        assert s.scalars(select(AlertSchedule).where(AlertSchedule.user_id == uid)).all() == []
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
        enqueue_due(s, now=datetime(2026, 10, 10, 8, 0, tzinfo=UTC))
        assert s.scalars(select(AlertSchedule).where(AlertSchedule.user_id == uid)).all() == []
    # A row that slips in anyway (and a subscription somehow live) still sends nothing.
    with get_session_factory()() as s, s.begin():
        for sub in s.scalars(select(PushSubscription).where(PushSubscription.user_id == uid)):
            sub.revoked_at = None
        s.add(
            AlertSchedule(
                user_id=uid,
                due_at=now - timedelta(minutes=1),
                type="group_activity",
                generic_label="Something happened in your group",
                dedupe_key="group:late",
            )
        )
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert browser.received == []
    assert not [m for m in outbox() if "recap" in m.subject.lower()]


def test_push_subscriptions_keep_the_newest_ten_per_person() -> None:
    """A person's live subscriptions are capped (10, proposed October 28, 2026): an 11th
    revokes the one registered longest ago, so a script can't make every alert fan out."""
    client, user_id = member("many")
    browsers = [FakeBrowser() for _ in range(11)]
    for b in browsers:
        r = client.post("/api/notifications/push", json=b.subscription())
        assert r.status_code == 201, r.text

    def live() -> set[str]:
        with get_session_factory()() as s:
            rows = s.scalars(
                select(PushSubscription).where(
                    PushSubscription.user_id == uuid.UUID(user_id),
                    PushSubscription.revoked_at.is_(None),
                )
            ).all()
            return {push.decrypt_subscription(r.payload_encrypted)["endpoint"] for r in rows}

    assert live() == {b.endpoint for b in browsers[1:]}
    # Registering the first again brings it back and lets the next oldest go.
    assert client.post("/api/notifications/push", json=browsers[0].subscription()).status_code == (
        201
    )
    assert live() == {b.endpoint for b in [browsers[0], *browsers[2:]]}


def test_push_failures_reach_the_admins_but_a_gone_endpoint_does_not(monkeypatch) -> None:
    """Invariant 11, an error never fails silently: a push service refusing us (a bad VAPID
    key answers 401 / 403) or a push we can't even build is reported through ops_alerts (which
    sends one email per kind and place an hour); a 404 / 410 is a subscription that went away,
    revoked quietly as before."""
    from app.services import ops_alerts

    reports: list[tuple[str, str]] = []
    monkeypatch.setattr(
        ops_alerts, "report", lambda kind, where, exc, **_: reports.append((kind, where)) or True
    )
    client, user_id = member("pushy")
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={"settings": {"quiet_start": "00:00", "quiet_end": "00:00", "timezone": "UTC"}},
    )
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)

    def due(key: str) -> None:
        items = [
            {
                "due_at": (now - timedelta(minutes=5)).isoformat(),
                "type": "upcoming_expense",
                "dedupe_key": key,
            }
        ]
        assert client.put("/api/alerts/schedule", json={"items": items}).status_code == 200

    browser.status = 403
    due("upcoming:a:2026-10-25")
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert ("push_rejected", "alert_dispatch.deliver: HTTP 403") in reports

    reports.clear()

    def broken(*_a, **_k):
        raise ValueError("Could not deserialize key data")

    monkeypatch.setattr(push, "build_request", broken)
    due("upcoming:b:2026-10-25")
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert ("push_failed", "alert_dispatch.deliver") in reports
    monkeypatch.undo()
    monkeypatch.setattr(
        ops_alerts, "report", lambda kind, where, exc, **_: reports.append((kind, where)) or True
    )

    reports.clear()
    browser.status = 410
    due("upcoming:c:2026-10-25")
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
        subs = s.scalars(
            select(PushSubscription).where(PushSubscription.user_id == uuid.UUID(user_id))
        ).all()
        assert all(sub.revoked_at is not None for sub in subs)
    assert not [r for r in reports if "410" in r[1]]


def test_weekly_recap_by_email_is_scheduled_by_the_server_and_sent_once() -> None:
    client, user_id = member("maya")
    r = client.put(
        "/api/notifications/settings",
        json={
            "settings": {"timezone": "UTC", "quiet_start": "00:00", "quiet_end": "00:00"},
            "prefs": {"weekly_recap": {"channel": "email", "days": "6", "time_of_day": "09:00"}},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["prefs"]["weekly_recap"]["channel"] == "email"
    assert (
        client.get("/api/notifications/settings").json()["prefs"]["shortfall_risk"]["channel"]
        is None
    )
    r = client.put(
        "/api/notifications/settings", json={"prefs": {"shortfall_risk": {"channel": "email"}}}
    )
    assert r.status_code == 422 and r.json()["detail"] == "channel_not_supported"
    outbox().clear()  # the sign-up code and its security alert

    # Saturday 08:00 UTC: the recap is due at 09:00 today, scheduled once
    saturday = datetime(2026, 10, 10, 8, 0, tzinfo=UTC)
    with get_session_factory()() as s:
        assert enqueue_due(s, now=saturday) == 1
        assert enqueue_due(s, now=saturday) == 0
        row = s.scalar(select(AlertSchedule).where(AlertSchedule.user_id == uuid.UUID(user_id)))
        assert row is not None
        assert row.dedupe_key == "recap:2026-10-10" and row.from_device is False
        assert row.due_at == datetime(2026, 10, 10, 9, 0, tzinfo=UTC)
        counts = dispatch_due(s, now=saturday)  # not due yet
    assert counts["email"] == 0 and outbox() == []

    with get_session_factory()() as s:
        counts = dispatch_due(s, now=datetime(2026, 10, 10, 9, 5, tzinfo=UTC))
    assert counts["email"] == 1 and counts["sent"] == 0
    assert len(outbox()) == 1
    message = outbox()[0]
    assert message.subject == "Your weekly recap is ready"
    assert "http://localhost:5173/recap" in message.text
    assert "$" not in message.text and "cents" not in message.text
    with get_session_factory()() as s:
        logged = s.scalar(
            select(NotificationLog).where(NotificationLog.dedupe_key == "recap:2026-10-10")
        )
        assert logged is not None and logged.channel == "email"
        # Never twice: a later run, or the device registering the same key, sends nothing
        assert dispatch_due(s, now=datetime(2026, 10, 10, 9, 30, tzinfo=UTC))["email"] == 0
    r = client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": "2026-10-10T09:00:00Z",
                    "type": "weekly_recap",
                    "dedupe_key": "recap:2026-10-10",
                }
            ]
        },
    )
    assert r.status_code == 200 and r.json()["registered"] == 0
    assert len(outbox()) == 1

    # Both: the push lands on /recap and the email goes too, each logged under its own key
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={"settings": {"daily_max": 0}, "prefs": {"weekly_recap": {"channel": "both"}}},
    )
    sunday = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)
    with get_session_factory()() as s:
        assert enqueue_due(s, now=sunday) == 1
        counts = dispatch_due(s, now=datetime(2026, 10, 17, 9, 1, tzinfo=UTC))
    assert counts["email"] == 1 and counts["sent"] >= 1  # counts span every user's due rows
    assert browser.received == [
        {
            "title": "Qash",
            "body": "Your weekly recap is ready",
            "tag": "recap:2026-10-17",
            "url": "/recap",
        }
    ]
    assert len(outbox()) == 2
    with get_session_factory()() as s:
        logged = {
            r.dedupe_key: r.channel
            for r in s.scalars(
                select(NotificationLog).where(NotificationLog.user_id == uuid.UUID(user_id))
            )
        }
    assert logged["recap:2026-10-17"] == "push" and logged["recap:2026-10-17:email"] == "email"

    # Paused: nothing by either channel
    client.put(
        "/api/notifications/settings",
        json={"settings": {"paused_until": "2026-10-31T00:00:00Z"}},
    )
    with get_session_factory()() as s:
        assert enqueue_due(s, now=datetime(2026, 10, 18, 12, 0, tzinfo=UTC)) == 1
        counts = dispatch_due(s, now=datetime(2026, 10, 24, 9, 1, tzinfo=UTC))
    assert counts["email"] == 0 and counts["skipped"] >= 1
    assert len(outbox()) == 2 and len(browser.received) == 1
    with get_session_factory()() as s:
        row = s.scalar(select(AlertSchedule).where(AlertSchedule.dedupe_key == "recap:2026-10-24"))
        assert row is not None and row.status == "skipped"


def test_native_push_registration_apns_and_fcm_delivery() -> None:
    """Chunk 2.3: the shells register APNs / FCM tokens; dispatch delivers the same generic
    labels through Apple and Google, revokes gone tokens, and the server never sees money."""
    import base64 as b64mod

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec as ec_mod
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    from app.config import get_settings

    client, user_id = member("maya")
    ios_token = "a1b2c3" * 12
    android_token = "fcm-token_ABC123:apa91-" + "x" * 40
    seen: list[httpx2.Request] = []
    gone: set[str] = set()

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if request.url.host == "oauth2.googleapis.com":
            return httpx2.Response(200, json={"access_token": "fcm-access", "expires_in": 3600})
        if request.url.path.endswith(ios_token) and "apns" in gone:
            return httpx2.Response(410)
        if "/v1/projects/" in request.url.path and "fcm" in gone:
            return httpx2.Response(404)
        return httpx2.Response(200)

    push_native.transport_override = httpx2.MockTransport(handle)
    push.transport_override = httpx2.MockTransport(handle)  # leftover web subs stay offline
    google_auth.reset_cache()

    # Registration: stored encrypted, one row per token, replayable without duplicates
    r = client.post(
        "/api/notifications/push/native",
        json={"platform": "ios", "token": ios_token, "user_agent": "Qash on iPhone"},
    )
    assert r.status_code == 201, r.text
    assert r.json() == {"available": True, "subscribed": True}
    assert (
        client.post(
            "/api/notifications/push/native", json={"platform": "ios", "token": ios_token}
        ).status_code
        == 201
    )
    r = client.post(
        "/api/notifications/push/native", json={"platform": "android", "token": android_token}
    )
    assert r.status_code == 201, r.text
    assert (
        client.post(
            "/api/notifications/push/native", json={"platform": "ios", "token": "short"}
        ).status_code
        == 422
    )
    with get_session_factory()() as s:
        rows = (
            s.query(PushSubscription)
            .filter(PushSubscription.user_id == uuid.UUID(user_id))
            .order_by(PushSubscription.platform)
            .all()
        )
        assert [row.platform for row in rows] == ["android", "ios"]
        for row in rows:
            assert ios_token not in row.payload_encrypted
            assert android_token not in row.payload_encrypted
        assert push.decrypt_subscription(rows[1].payload_encrypted) == {
            "platform": "ios",
            "token": ios_token,
        }
    assert client.get("/api/notifications/settings").json()["push"]["subscribed"] is True

    # Dispatch: one due alert goes to both platforms with the generic label only
    client.put(
        "/api/notifications/settings",
        json={
            "settings": {
                "quiet_start": "00:00",
                "quiet_end": "00:00",
                "daily_max": 0,
                "timezone": "UTC",
            }
        },
    )
    now = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (now - timedelta(minutes=5)).isoformat(),
                    "type": "upcoming_expense",
                    "dedupe_key": "upcoming:rent:2026-11-01",
                }
            ]
        },
    )
    seen.clear()
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    apns = [r for r in seen if r.url.host.endswith(".push.apple.com")]
    assert len(apns) == 1
    assert apns[0].url.host == "api.sandbox.push.apple.com"
    assert apns[0].url.path == f"/3/device/{ios_token}"
    assert apns[0].headers["apns-topic"] == "com.stackd.app"
    assert apns[0].headers["apns-push-type"] == "alert"
    assert apns[0].headers["apns-collapse-id"] == "upcoming:rent:2026-11-01"
    token_jwt = apns[0].headers["authorization"].removeprefix("bearer ")
    head, claims, sig = token_jwt.split(".")

    def unb64(text: str) -> bytes:
        return b64mod.urlsafe_b64decode(text + "=" * (-len(text) % 4))

    assert json.loads(unb64(head)) == {"alg": "ES256", "kid": "TESTKEY123"}
    assert json.loads(unb64(claims))["iss"] == "TEAMTEST12"
    apns_key = serialization.load_pem_private_key(
        get_settings().apns_key.get_secret_value().encode(), password=None
    )
    raw = unb64(sig)
    apns_key.public_key().verify(
        encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
        f"{head}.{claims}".encode(),
        ec_mod.ECDSA(hashes.SHA256()),
    )
    apns_body = json.loads(apns[0].content)
    assert apns_body["aps"]["alert"] == {
        "title": "Qash",
        "body": "An expected expense is coming up",
    }
    assert apns_body["url"] == "/forecast"
    assert "$" not in apns[0].content.decode() and "cents" not in apns[0].content.decode()

    oauth = [r for r in seen if r.url.host == "oauth2.googleapis.com"]
    assert len(oauth) == 1
    fcm = [r for r in seen if "/v1/projects/" in r.url.path]
    assert len(fcm) == 1
    assert fcm[0].url.path == "/v1/projects/stackd-test/messages:send"
    assert fcm[0].headers["authorization"] == "Bearer fcm-access"
    message = json.loads(fcm[0].content)["message"]
    assert message["token"] == android_token
    assert message["notification"]["body"] == "An expected expense is coming up"
    assert message["data"] == {"url": "/forecast", "tag": "upcoming:rent:2026-11-01"}

    # The OAuth token is cached; gone tokens are revoked (APNs 410, FCM 404)
    gone.update({"apns", "fcm"})
    seen.clear()
    client.put(
        "/api/alerts/schedule",
        json={
            "items": [
                {
                    "due_at": (now - timedelta(minutes=4)).isoformat(),
                    "type": "weekly_recap",
                    "dedupe_key": "recap:2026-10-11",
                }
            ]
        },
    )
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert [r for r in seen if r.url.host == "oauth2.googleapis.com"] == []
    assert client.get("/api/notifications/settings").json()["push"]["subscribed"] is False
    with get_session_factory()() as s:
        rows = (
            s.query(PushSubscription).filter(PushSubscription.user_id == uuid.UUID(user_id)).all()
        )
        assert all(row.revoked_at is not None for row in rows)


def test_native_push_registration_needs_credentials(monkeypatch) -> None:
    client, _ = member("maya")
    monkeypatch.setattr(push_native, "available", lambda platform: False)
    r = client.post("/api/notifications/push/native", json={"platform": "ios", "token": "a" * 64})
    assert r.status_code == 503 and r.json()["detail"] == "push_unavailable"


def test_native_unsubscribe_is_scoped_to_the_owner() -> None:
    maya, _ = member("maya")
    other, _ = member("dev")
    token = "b" * 64
    assert (
        maya.post(
            "/api/notifications/push/native", json={"platform": "ios", "token": token}
        ).status_code
        == 201
    )
    # someone else sending the same token releases nothing
    assert (
        other.post(
            "/api/notifications/push/native/unsubscribe",
            json={"platform": "ios", "token": token},
        ).status_code
        == 204
    )
    assert maya.get("/api/notifications/settings").json()["push"]["subscribed"] is True
    assert (
        maya.post(
            "/api/notifications/push/native/unsubscribe",
            json={"platform": "ios", "token": token},
        ).status_code
        == 204
    )
    assert maya.get("/api/notifications/settings").json()["push"]["subscribed"] is False
