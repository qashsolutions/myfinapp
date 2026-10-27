"""Ownership checks used by every router.

docs/spec.md "Security": authorization check on every row by user_id, with integration tests
for cross-user access (tests/authz/). The answer for someone else's row is 404, never 403,
so the existence of a row is not revealed either.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from fastapi import HTTPException, status
from sqlalchemy import Select
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class Principal:
    """Who is making the request. Built from the session by chunk 1.2; routers never build one."""

    user_id: uuid.UUID
    session_id: uuid.UUID | None = None
    passkey_verified_at: datetime | None = None  # last fresh passkey assertion; step_up reads it
    has_passkeys: bool = True  # the account has at least one passkey (mandatory after sign-up)
    locked: bool = False  # this session needs a passkey check before it can read app data


class Owned(Protocol):
    user_id: uuid.UUID


def not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")


def assert_owner[R: Owned](row: R | None, principal: Principal) -> R:
    """Return the row if it belongs to the principal; otherwise 404 (also when it is None)."""
    if row is None or row.user_id != principal.user_id:
        raise not_found()
    return row


def owned_by(stmt: Select[Any], model: Any, principal: Principal) -> Select[Any]:
    """Add the ownership filter to a select. Lists must always go through this."""
    return stmt.where(model.user_id == principal.user_id)


def get_owned[R: Owned](
    session: Session, model: type[R], row_id: uuid.UUID, principal: Principal
) -> R:
    """Load one row by id and check ownership in one call."""
    return assert_owner(session.get(model, row_id), principal)
