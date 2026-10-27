"""Audit-log retention (docs/security/security-plan.md "Logging and monitoring"): rows older
than 13 months are deleted by a daily scheduled job. Nothing else ever deletes audit rows."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session as DbSession

from app.models.audit_log import AuditLog

RETENTION = timedelta(days=396)  # 13 months, rounded up


def purge(db: DbSession, *, now: datetime | None = None) -> dict[str, int]:
    cutoff = (now or datetime.now(UTC)) - RETENTION
    result = db.execute(delete(AuditLog).where(AuditLog.at < cutoff))
    db.commit()
    return {"audit_rows_deleted": int(result.rowcount or 0)}
