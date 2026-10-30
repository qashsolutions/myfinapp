"""The first migration applies, reverses, and matches the ORM models exactly."""

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import Engine, inspect, text

from app.db import alembic_config, migration_status
from app.models import Base


def test_head_is_latest_migration(migrated: Engine) -> None:
    with migrated.connect() as conn:
        current, head = migration_status(conn)
    assert head == "0041"
    assert current == head


def test_users_table_exists_with_constraints(migrated: Engine) -> None:
    insp = inspect(migrated)
    assert "users" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("users")}
    assert {"id", "created_at", "updated_at", "email", "look", "mode", "deleted_at"} <= cols
    uniques = {u["name"] for u in insp.get_unique_constraints("users")}
    assert "uq_users_email" in uniques
    checks = {c["name"] for c in insp.get_check_constraints("users")}
    assert {"ck_users_look", "ck_users_mode", "ck_users_receipt_retention"} <= checks


def test_security_tables_exist(migrated: Engine) -> None:
    insp = inspect(migrated)
    assert {"audit_log", "rate_limit_buckets"} <= set(insp.get_table_names())
    assert {c["name"] for c in insp.get_columns("audit_log")} >= {
        "actor_id",
        "action",
        "target",
        "ip_hash",
        "at",
    }
    pk = insp.get_pk_constraint("rate_limit_buckets")
    assert pk["constrained_columns"] == ["scope", "key", "window_start"]


def test_models_and_migrations_agree(migrated: Engine) -> None:
    """Autogenerate must find nothing to do: the hand-written migration matches the models."""
    with migrated.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": True})
        diff = compare_metadata(ctx, Base.metadata)
    assert diff == [], diff


def test_defaults_and_check_constraints_apply(migrated: Engine) -> None:
    with migrated.begin() as conn:
        conn.execute(text("INSERT INTO users (email) VALUES ('defaults@example.com')"))
        row = conn.execute(
            text(
                "SELECT look, mode, simple_layout, receipt_retention FROM users "
                "WHERE email = 'defaults@example.com'"
            )
        ).one()
        assert tuple(row) == ("modern", "system", False, "90d")
        conn.execute(text("DELETE FROM users WHERE email = 'defaults@example.com'"))
    with migrated.connect() as conn:
        try:
            conn.execute(text("INSERT INTO users (email, look) VALUES ('b@example.com', 'neon')"))
        except Exception as exc:  # psycopg CheckViolation
            assert "ck_users_look" in str(exc)
        else:
            raise AssertionError("CHECK constraint on look did not fire")
        conn.rollback()


def test_downgrade_removes_everything(migrated: Engine) -> None:
    cfg = alembic_config()
    command.downgrade(cfg, "base")
    try:
        with migrated.connect() as conn:
            assert "users" not in inspect(conn).get_table_names()
            assert migration_status(conn)[0] is None
    finally:
        command.upgrade(cfg, "head")
