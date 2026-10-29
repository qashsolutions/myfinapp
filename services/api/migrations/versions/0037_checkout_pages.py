"""Open payment pages (October 29, 2026)

- checkout_pages: the Stripe Checkout pages opened for a person and when each closes, so a new
  page first closes the older ones and two pages can never both be paid. Deleted a day after
  they close (`purge-expired`).

Revision ID: 0037
Revises: 0036
Create Date: 2026-10-29

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "checkout_pages",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.String(120), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_checkout_pages_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_checkout_pages")),
    )
    op.create_index(op.f("ix_checkout_pages_user_id"), "checkout_pages", ["user_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_checkout_pages_user_id"), table_name="checkout_pages")
    op.drop_table("checkout_pages")
