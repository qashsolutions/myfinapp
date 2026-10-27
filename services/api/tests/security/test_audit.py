import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import Engine

from app.db import get_session_factory
from app.models.audit_log import AuditLog
from app.security.audit import AuditAction, record
from app.security.hashing import pseudonym


def test_record_stores_pseudonymous_ip_and_closed_action(migrated: Engine) -> None:
    actor = uuid.uuid4()
    with get_session_factory()() as s, s.begin():
        row = record(
            s, actor_id=actor, action=AuditAction.SIGN_IN, target="session:x1", ip="203.0.113.9"
        )
        row_id = row.id
    with get_session_factory()() as s:
        got = s.get(AuditLog, row_id)
    assert got is not None
    assert got.actor_id == actor
    assert got.action == "sign_in"
    assert got.target == "session:x1"
    assert got.ip_hash != "203.0.113.9"
    assert got.ip_hash == pseudonym("203.0.113.9")  # stable, so abuse can be correlated
    assert len(got.ip_hash) == 32
    assert got.at.tzinfo is not None and got.at <= datetime.now(UTC)


def test_action_strings_are_coerced_and_unknown_rejected(migrated: Engine) -> None:
    with get_session_factory()() as s:
        row = record(s, actor_id=None, action="admin_action", target="user:abc")
        assert row.action == AuditAction.ADMIN_ACTION
        with pytest.raises(ValueError):
            record(s, actor_id=None, action="transferred_money")
        s.rollback()


def test_target_must_be_a_short_identifier(migrated: Engine) -> None:
    with get_session_factory()() as s:
        with pytest.raises(ValueError):
            record(s, actor_id=None, action=AuditAction.EXPORT, target="x" * 121)
        with pytest.raises(ValueError):
            record(s, actor_id=None, action=AuditAction.EXPORT, target="spent $412.10 at Target")
        s.rollback()


def test_missing_ip_is_null_not_hashed_empty(migrated: Engine) -> None:
    with get_session_factory()() as s:
        row = record(s, actor_id=None, action=AuditAction.SIGN_OUT)
        assert row.ip_hash is None
        s.rollback()
