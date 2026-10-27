"""purchase_consents: the "Before you subscribe" agreement, recorded before the payment page
(owner decision, October 14, 2026)

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-14

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "purchase_consents",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("email_hash", sa.String(64), nullable=False),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("interval", sa.String(8), nullable=True),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("terms_version", sa.String(16), nullable=False),
        sa.Column("terms_text", sa.Text(), nullable=False),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("device_label", sa.String(80), nullable=True),
        sa.Column("agreed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_consents")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_purchase_consents_user_id_users"),
            ondelete="SET NULL",
        ),
    )
    op.create_index(op.f("ix_purchase_consents_user_id"), "purchase_consents", ["user_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_purchase_consents_user_id"), table_name="purchase_consents")
    op.drop_table("purchase_consents")
