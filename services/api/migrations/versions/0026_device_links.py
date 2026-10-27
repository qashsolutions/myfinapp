"""device_links: "Link with your phone" (owner decisions, October 19, 2026)

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-19

Written by hand from app/models/device_link.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_links",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("secret_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), server_default="pending", nullable=False),
        sa.Column("device_label", sa.String(80), nullable=False),
        sa.Column("network_hash", sa.String(32), nullable=True),
        sa.Column("ip_hash", sa.String(32), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("approved_by", sa.Uuid(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'consumed', 'denied')",
            name=op.f("ck_device_links_status"),
        ),
        sa.ForeignKeyConstraint(
            ["approved_by"],
            ["users.id"],
            name=op.f("fk_device_links_approved_by_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
            name=op.f("fk_device_links_session_id_sessions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_device_links")),
        sa.UniqueConstraint("code_hash", name=op.f("uq_device_links_code_hash")),
        sa.UniqueConstraint("secret_hash", name=op.f("uq_device_links_secret_hash")),
    )
    op.create_index(op.f("ix_device_links_approved_by"), "device_links", ["approved_by"])


def downgrade() -> None:
    op.drop_index(op.f("ix_device_links_approved_by"), table_name="device_links")
    op.drop_table("device_links")
