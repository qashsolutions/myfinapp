"""A budget alert in the moment (budget_pace): the key names a month, a tag and a level only;
the label is generic (and says "reached" at the whole plan); a level fires once a month; the
"Tell me at" percent takes 50-150. Invariant 28 in docs/invariants.md."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.db import get_session_factory
from app.jobs.alert_dispatch import dispatch_due
from app.services import push
from tests.test_notifications import FakeBrowser, member

CLOSE = "A budget category is close to its plan. Open Qash to see which."
REACHED = "A budget category has reached its plan."


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    push.transport_override = None
    yield
    push.transport_override = None


def _put(client, items):
    return client.put("/api/alerts/schedule", json={"items": items})


def test_budget_alert_labels_are_generic_and_keys_name_nothing() -> None:
    client, _ = member("maya")
    due = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    keys = ["budget:2026-10:lekdgdiedlbpekao:9000", "budget:2026-10:hhcfiaobpimigffm:10000"]
    r = _put(client, [{"due_at": due, "type": "budget_pace", "dedupe_key": k} for k in keys])
    assert r.status_code == 200, r.text
    labels = {i["dedupe_key"]: i["generic_label"] for i in r.json()["items"]}
    assert labels == {
        "budget:2026-10:lekdgdiedlbpekao:9000": CLOSE,
        "budget:2026-10:hhcfiaobpimigffm:10000": REACHED,
    }
    # A category id, a name or an amount in the key is refused, never stored.
    for bad in (
        "budget:2026-10:cat-dining:9000",
        "budget:2026-10:Dining:9000",
        "budget:2026-10:lekdgdiedlbpekao:9000:18000",
        "budget:2026-10:lekdgdiedlbpekaoq:9000",
        "upcoming:rent:2026-10-25",
    ):
        r = _put(client, [{"due_at": due, "type": "budget_pace", "dedupe_key": bad}])
        assert r.status_code == 422, bad
    # The earlier good list is still the registered one.
    keys = [i["dedupe_key"] for i in client.get("/api/alerts/schedule").json()["items"]]
    assert sorted(keys) == [
        "budget:2026-10:hhcfiaobpimigffm:10000",
        "budget:2026-10:lekdgdiedlbpekao:9000",
    ]


def test_a_budget_level_alerts_once_a_month() -> None:
    client, _ = member("maya")
    browser = FakeBrowser()
    push.transport_override = browser.transport()
    assert client.post("/api/notifications/push", json=browser.subscription()).status_code == 201
    client.put(
        "/api/notifications/settings",
        json={"settings": {"quiet_start": "00:00", "quiet_end": "00:00", "daily_max": 0}},
    )
    now = datetime(2026, 10, 22, 13, 5, tzinfo=UTC)
    key = "budget:2026-10:lekdgdiedlbpekao:9000"
    item = {"due_at": now.isoformat(), "type": "budget_pace", "dedupe_key": key}
    _put(client, [item])
    with get_session_factory()() as s:
        dispatch_due(s, now=now)
    assert browser.received == [{"title": "Qash", "body": CLOSE, "tag": key, "url": "/budget"}]
    # The device registers the same crossing again (every recompute does): nothing more goes.
    _put(client, [item])
    with get_session_factory()() as s:
        dispatch_due(s, now=now + timedelta(hours=2))
    assert len(browser.received) == 1
    text = json.dumps(browser.received)
    assert "$" not in text and "cents" not in text and "Dining" not in text


def test_tell_me_at_takes_fifty_to_one_fifty_percent() -> None:
    client, _ = member("maya")
    prefs = client.get("/api/notifications/settings").json()["prefs"]
    assert prefs["budget_pace"]["enabled"] is True
    assert prefs["budget_pace"]["time_of_day"] == "09:00"
    assert prefs["budget_pace"]["threshold"] is None  # the rules config's 90% and 100%
    r = client.put(
        "/api/notifications/settings", json={"prefs": {"budget_pace": {"threshold": 120}}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["prefs"]["budget_pace"]["threshold"] == 120
    for bad in (49, 151):
        r = client.put(
            "/api/notifications/settings", json={"prefs": {"budget_pace": {"threshold": bad}}}
        )
        assert r.status_code == 422, bad
    # goal_behind_pace keeps its own 1-4 periods
    r = client.put(
        "/api/notifications/settings", json={"prefs": {"goal_behind_pace": {"threshold": 90}}}
    )
    assert r.status_code == 422
