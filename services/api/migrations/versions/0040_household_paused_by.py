"""users.household_paused_by (October 29, 2026)

A household that splits while a payment for its plan is disputed (invariant 68): the partner
that plan covered stays paused, never closed, until the dispute closes; this keeps which
subscription's dispute it waits on. When it closes (won or lost) their own 7 days start then.

Revision ID: 0040
Revises: 0039
Create Date: 2026-10-29

Written by hand from app/models/user.py. A nullable column only, so the build before this one
keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("household_paused_by", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "household_paused_by")
