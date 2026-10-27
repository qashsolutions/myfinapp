"""Liveness and readiness.

GET /health        always 200 while the process runs; no dependencies touched.
GET /health/ready  200 when the database answers, migrations are at head and the backup
                   bucket exists; 503 with one short word per failing check otherwise.
                   Details go to the server log, never to the response.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app import API_VERSION
from app.db import get_engine, migration_status
from app.storage import bucket_exists

log = logging.getLogger(__name__)
router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def live() -> dict[str, str]:
    return {"status": "ok", "service": "stackd-api", "version": API_VERSION}


def check_db_and_migrations() -> tuple[str, str]:
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
            current, head = migration_status(conn)
    except Exception:
        log.exception("readiness: database check failed")
        return "unreachable", "unknown"
    return "ok", ("ok" if current == head and head is not None else "behind")


def check_storage() -> str:
    try:
        return "ok" if bucket_exists() else "missing"
    except Exception:
        log.exception("readiness: storage check failed")
        return "unreachable"


@router.get("/ready")
def ready(response: Response) -> dict[str, object]:
    db, migrations = check_db_and_migrations()
    checks = {"db": db, "migrations": migrations, "storage": check_storage()}
    ok = all(v == "ok" for v in checks.values())
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if ok else "degraded", "checks": checks}
