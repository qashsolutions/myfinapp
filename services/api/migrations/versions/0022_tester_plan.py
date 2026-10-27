"""users.tester_plan: the plan an admin tests with, free of charge

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-18

Written by hand from app/models/user.py. Tester tools (owner decision, October 18, 2026): an
account whose email is in STACKD_ADMIN_EMAILS may switch its own plan for free to test every
plan; the choice is kept here and ignored for anyone else.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("tester_plan", sa.String(length=16), nullable=True))
    op.create_check_constraint(
        "tester_plan",
        "users",
        "tester_plan IS NULL OR tester_plan IN ('free', 'private', 'connected', 'founding')",
    )


def downgrade() -> None:
    op.drop_constraint("tester_plan", "users", type_="check")
    op.drop_column("users", "tester_plan")
