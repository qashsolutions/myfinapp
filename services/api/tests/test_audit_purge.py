"""Audit-log retention: rows older than 13 months go, newer ones stay."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.db import get_session_factory
from app.jobs.audit_purge import purge
from app.models.audit_log import AuditLog
from app.security.audit import AuditAction, record


def test_rows_older_than_thirteen_months_are_deleted(migrated) -> None:
    actor = uuid.uuid4()
    now = datetime.now(UTC)
    with get_session_factory()() as db:
        record(db, actor_id=actor, action=AuditAction.SIGN_IN, at=now - timedelta(days=400))
        record(db, actor_id=actor, action=AuditAction.EXPORT, at=now - timedelta(days=300))
        db.commit()
    with get_session_factory()() as db:
        assert purge(db, now=now)["audit_rows_deleted"] >= 1
    with get_session_factory()() as db:
        left = db.scalars(select(AuditLog.action).where(AuditLog.actor_id == actor)).all()
    assert left == ["export"]
