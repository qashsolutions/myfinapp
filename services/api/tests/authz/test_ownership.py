"""Cross-user access: the helpers every router must use, exercised the way a router uses them.

Grows with each router: every route that reads or writes a user-owned row gets a case here
where another signed-in user tries it and gets 404.
"""

import uuid
from collections.abc import Iterator
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import Engine, String, Uuid, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from app.db import get_db, get_session_factory
from app.models.base import StackdRow
from app.security.authz import Principal, assert_owner, get_owned, owned_by


class ScratchBase(DeclarativeBase):
    """Separate metadata: this table is test scaffolding, not part of the app's schema."""


class Thing(ScratchBase, StackdRow):
    __tablename__ = "authz_test_things"
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    name: Mapped[str] = mapped_column(String(40))


@pytest.fixture(scope="module")
def world(migrated: Engine) -> Iterator[dict]:
    ScratchBase.metadata.create_all(migrated)
    alice, bob = Principal(uuid.uuid4()), Principal(uuid.uuid4())
    with get_session_factory()() as s, s.begin():
        a, b = (
            Thing(user_id=alice.user_id, name="alice's"),
            Thing(user_id=bob.user_id, name="bob's"),
        )
        s.add_all([a, b])
        s.flush()
        ids = {"alice_thing": a.id, "bob_thing": b.id}
    yield {"alice": alice, "bob": bob, **ids}
    ScratchBase.metadata.drop_all(migrated)


def test_owner_reads_own_row(world: dict) -> None:
    with get_session_factory()() as s:
        assert get_owned(s, Thing, world["alice_thing"], world["alice"]).name == "alice's"


def test_other_user_gets_404_not_403(world: dict) -> None:
    with get_session_factory()() as s, pytest.raises(HTTPException) as exc:
        get_owned(s, Thing, world["alice_thing"], world["bob"])
    assert exc.value.status_code == 404
    assert exc.value.detail == "not_found"


def test_missing_row_is_the_same_404(world: dict) -> None:
    with get_session_factory()() as s, pytest.raises(HTTPException) as exc:
        get_owned(s, Thing, uuid.uuid4(), world["alice"])
    assert exc.value.status_code == 404


def test_assert_owner_on_none() -> None:
    with pytest.raises(HTTPException) as exc:
        assert_owner(None, Principal(uuid.uuid4()))
    assert exc.value.status_code == 404


def test_owned_by_filters_lists(world: dict) -> None:
    with get_session_factory()() as s:
        names = s.scalars(owned_by(select(Thing), Thing, world["alice"])).all()
    assert [t.name for t in names] == ["alice's"]


def test_route_pattern_denies_cross_user(world: dict) -> None:
    """How every router is expected to look: principal + get_db, get_owned on the way in."""

    def current_principal() -> Principal:  # replaced by the session layer in chunk 1.2
        raise NotImplementedError

    app = FastAPI()

    @app.get("/things/{thing_id}")
    def read_thing(
        thing_id: uuid.UUID,
        principal: Annotated[Principal, Depends(current_principal)],
        db: Annotated[Session, Depends(get_db)],
    ) -> dict[str, str]:
        return {"name": get_owned(db, Thing, thing_id, principal).name}

    app.dependency_overrides[current_principal] = lambda: world["bob"]
    with TestClient(app) as c:
        assert c.get(f"/things/{world['bob_thing']}").json() == {"name": "bob's"}
        r = c.get(f"/things/{world['alice_thing']}")
        assert r.status_code == 404
        assert r.json() == {"detail": "not_found"}
