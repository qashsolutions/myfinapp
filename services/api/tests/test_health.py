import tomllib
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient

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
