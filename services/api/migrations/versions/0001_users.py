"""users: the account row (chunk 0.4)

Revision ID: 0001
Revises:
Create Date: 2026-10-10

Written by hand from app/models/user.py; tests/test_migrations.py fails if the two drift.
Names are wrapped in op.f() so the naming convention in app/models/base.py is not applied twice.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("display_name", sa.String(80), nullable=True),
        sa.Column("look", sa.String(16), server_default="modern", nullable=False),
        sa.Column("mode", sa.String(16), server_default="system", nullable=False),
        sa.Column("simple_layout", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("receipt_retention", sa.String(16), server_default="90d", nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
        sa.CheckConstraint("look IN ('modern', 'pastel', 'anime')", name=op.f("ck_users_look")),
        sa.CheckConstraint("mode IN ('light', 'dark', 'system')", name=op.f("ck_users_mode")),
        sa.CheckConstraint(
            "receipt_retention IN ('90d', '1y', 'forever')", name=op.f("ck_users_receipt_retention")
        ),
    )


def downgrade() -> None:
    op.drop_table("users")
