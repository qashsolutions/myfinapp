"""Database engine, request-scoped sessions and the Alembic hooks the app itself needs."""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request. Routers commit explicitly."""
    with get_session_factory()() as session:
        yield session


def alembic_config() -> AlembicConfig:
    return AlembicConfig(str(ALEMBIC_INI))


def migration_status(connection: Connection) -> tuple[str | None, str | None]:
    """(revision the database is at, head revision in migrations/versions)."""
    current = MigrationContext.configure(connection).get_current_revision()
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    return current, head
