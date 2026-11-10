"""What a request costs the database stays flat (load test, October 31, 2026).

Every signed-in request starts by reading its session; the alert schedule arrives with up to
300 items. Both used to cost queries per call or per item. These pin the counts so a change
that brings them back fails here rather than in production under load.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event

from app.db import get_engine, get_session_factory
from app.services import sessions as sessions_svc
from tests.auth_flow import new_client, sign_in_with_code, sign_up
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


@contextmanager
def counted() -> Iterator[list[str]]:
    seen: list[str] = []

    def count(conn, cursor, statement, *_args) -> None:
        seen.append(statement)

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", count)


def test_a_signed_in_request_reads_its_session_account_and_passkey_in_one_query() -> None:
    client = new_client()
    sign_in_with_code(client, f"c+{uuid.uuid4().hex[:6]}@example.com")
    token = client.cookies.get(sessions_svc.COOKIE_NAME)
    with get_session_factory()() as s, counted() as seen:
        found = sessions_svc.load_signed_in(s, token)
    assert found is not None and found[2] is False  # signed in by code, no passkey yet
    assert len(seen) == 1

    sign_up(client, f"d+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    token = client.cookies.get(sessions_svc.COOKIE_NAME)
    with get_session_factory()() as s:
        found = sessions_svc.load_signed_in(s, token)
        assert found is not None and found[2] is True
        found[0].revoked_at = datetime.now(UTC)
        s.flush()
        assert sessions_svc.load_signed_in(s, token) is None  # a revoked session is no session
        s.rollback()
    with get_session_factory()() as s:
        found = sessions_svc.load_signed_in(s, token)
        found[1].deleted_at = datetime.now(UTC)
        s.flush()
        assert sessions_svc.load_signed_in(s, token) is None  # nor is a deleted account's
        s.rollback()


def test_the_alert_schedule_costs_the_same_queries_for_10_items_or_300() -> None:
    client = new_client()
    sign_up(client, f"a+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())
    day = datetime.now(UTC) + timedelta(days=1)

    def put(n: int) -> int:
        items = [
            {
                "due_at": (day + timedelta(hours=i)).isoformat(),
                "type": "upcoming_expense",
                "dedupe_key": f"bill:{n}:{i}",
            }
            for i in range(n)
        ]
        with counted() as seen:
            r = client.put("/api/alerts/schedule", json={"items": items})
        assert r.status_code == 200, r.text
        assert r.json()["registered"] == n
        return len(seen)

    assert put(10) == put(300)
