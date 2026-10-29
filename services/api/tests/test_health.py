import tomllib
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import API_VERSION
from app.config import get_settings
from app.db import alembic_config
from app.main import create_app


def test_version_matches_pyproject() -> None:
    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    assert pyproject["project"]["version"] == API_VERSION


def test_live_needs_no_dependencies(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "stackd-api", "version": API_VERSION}


def test_ready_ok_at_head_with_bucket(client: TestClient, migrated, bucket) -> None:
    r = client.get("/health/ready")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "checks": {"db": "ok", "migrations": "ok", "storage": "ok"}}


def test_ready_reports_migrations_behind(client: TestClient, migrated, bucket) -> None:
    cfg = alembic_config()
    command.downgrade(cfg, "base")
    try:
        r = client.get("/health/ready")
        assert r.status_code == 503
        assert r.json() == {
            "status": "degraded",
            "checks": {"db": "ok", "migrations": "behind", "storage": "ok"},
        }
    finally:
        command.upgrade(cfg, "head")


def test_ready_reports_missing_bucket(
    client: TestClient, migrated, bucket, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "s3_bucket", "stackd-no-such-bucket")
    r = client.get("/health/ready")
    assert r.status_code == 503
    assert r.json()["checks"]["storage"] == "missing"


def test_docs_served_in_test(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200


def test_docs_hidden_in_prod(prod_settings: None) -> None:
    with TestClient(create_app(), headers={"X-Origin-Verify": "test-origin-verify"}) as c:
        assert c.get("/openapi.json").status_code == 404
        assert c.get("/docs").status_code == 404
        assert c.get("/health").status_code == 200


def _stamp(engine, revision: str) -> None:
    with engine.begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = :v"), {"v": revision})


def test_a_newer_database_keeps_this_build_ready_and_starting(
    client: TestClient, migrated, bucket, capsys
) -> None:
    """October 29, 2026: a deploy migrated the database and then did not go live, and the
    older build crashed at start on a revision it did not know. Migrations stay backward
    compatible for one release, so an older build keeps running on a newer database."""
    from app.cli import migrate
    from app.db import get_engine, migration_status

    engine = get_engine()
    with engine.connect() as conn:
        head, _ = migration_status(conn)
    _stamp(engine, "9999")
    try:
        r = client.get("/health/ready")
        assert r.status_code == 200, r.text
        assert r.json()["checks"]["migrations"] == "ok"
        assert migrate(check_only=False) == 0
        assert migrate(check_only=True) == 0
        assert "newer than this build" in capsys.readouterr().out
    finally:
        _stamp(engine, head)
