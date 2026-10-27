"""users.lock_after_minutes: auto-lock after 5 to 60 idle minutes, the user's choice (owner
decision, October 12, 2026; was a fixed 5 minutes)

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-12

Written by hand from app/models/user.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("lock_after_minutes", sa.Integer(), server_default="5", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_users_lock_after_minutes"), "users", "lock_after_minutes BETWEEN 5 AND 60"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_users_lock_after_minutes"), "users", type_="check")
    op.drop_column("users", "lock_after_minutes")
