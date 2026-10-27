"""users.look takes the six looks (owner decision, October 12, 2026)

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-12

Written by hand from app/models/user.py.
"""

from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

NEW = "'modern', 'minimal', 'retro', 'pastel', 'anime', 'illustrative'"
OLD = "'modern', 'pastel', 'anime'"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_users_look"), "users", type_="check")
    op.create_check_constraint(op.f("ck_users_look"), "users", f"look IN ({NEW})")


def downgrade() -> None:
    op.execute(f"UPDATE users SET look = 'modern' WHERE look NOT IN ({OLD})")
    op.drop_constraint(op.f("ck_users_look"), "users", type_="check")
    op.create_check_constraint(op.f("ck_users_look"), "users", f"look IN ({OLD})")
