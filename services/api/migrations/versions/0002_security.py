"""audit_log and rate_limit_buckets (chunk 0.5)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-10

Written by hand from app/models/audit_log.py and app/models/rate_limit.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("target", sa.String(120), nullable=True),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_log")),
    )
    op.create_index(op.f("ix_audit_log_actor_id_at"), "audit_log", ["actor_id", "at"])

    op.create_table(
        "rate_limit_buckets",
        sa.Column("scope", sa.String(40), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("scope", "key", "window_start", name=op.f("pk_rate_limit_buckets")),
    )


def downgrade() -> None:
    op.drop_table("rate_limit_buckets")
    op.drop_index(op.f("ix_audit_log_actor_id_at"), table_name="audit_log")
    op.drop_table("audit_log")
