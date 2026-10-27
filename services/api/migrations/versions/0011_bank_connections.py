"""bank_connections and link_sessions (Phase 3, chunk 3.2)

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-11

Written by hand from app/models/linking.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def _row_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "bank_connections",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("item_id", sa.String(length=100), nullable=False),
        sa.Column("access_token_encrypted", sa.Text(), nullable=False),
        sa.Column("key_id", sa.String(length=16), nullable=False),
        sa.Column("institution_name", sa.String(length=120), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_bank_connections_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bank_connections")),
        sa.UniqueConstraint("item_id", name=op.f("uq_bank_connections_item_id")),
    )
    op.create_index(
        op.f("ix_bank_connections_user_id"), "bank_connections", ["user_id"], unique=False
    )
    op.create_table(
        "link_sessions",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("link_token_encrypted", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_link_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_link_sessions")),
    )
    op.create_index(op.f("ix_link_sessions_user_id"), "link_sessions", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_link_sessions_user_id"), table_name="link_sessions")
    op.drop_table("link_sessions")
    op.drop_index(op.f("ix_bank_connections_user_id"), table_name="bank_connections")
    op.drop_table("bank_connections")
