"""users.household_cover_ended_at, users.shared_reminded_days (October 29, 2026)

A household of two is one plan (owner decision, October 29, 2026; invariant 54):

- users.household_cover_ended_at: when the household's shared plan stopped covering this
  person (they left, or the plan's holder left or closed their account). Their 7 days to pick
  a plan or download start then, as when a plan of their own ends.
- users.shared_reminded_days: the last Founding reminder stage (30, 7 or 1 day before) sent to
  the covered partner for the holder's term, so each goes to them once too.

Revision ID: 0039
Revises: 0038
Create Date: 2026-10-29

Written by hand from app/models/user.py. Nullable columns only, so the build before this one
keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("household_cover_ended_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("shared_reminded_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "shared_reminded_days")
    op.drop_column("users", "household_cover_ended_at")
