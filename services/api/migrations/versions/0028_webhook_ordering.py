"""Stripe webhook ordering and disputes (October 24, 2026)

- subscriptions.last_event_at: when Stripe created the newest event applied to this row, so a
  late or out-of-order delivery of an older event is skipped.
- subscriptions.stripe_status: Stripe's own status; "canceled" there is final.
- subscriptions.disputed_at: a payment on the plan is disputed; the plan pauses until the
  dispute is won or withdrawn (owner decision).
- subscriptions.first_payment: pending / paid / failed for a first payment by US bank, which
  Stripe calls active before it has cleared.
- purchase_blocks: inboxes (as keyed pseudonyms) that may not buy again after a lost dispute or
  a payment the card's bank flagged as fraud (owner decision).

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-24

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions", sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("subscriptions", sa.Column("stripe_status", sa.String(32), nullable=True))
    op.add_column(
        "subscriptions", sa.Column("disputed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("subscriptions", sa.Column("first_payment", sa.String(16), nullable=True))
    op.create_table(
        "purchase_blocks",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("email_hash", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.CheckConstraint(
            "reason IN ('dispute_lost', 'fraud_warning')",
            name=op.f("ck_purchase_blocks_block_reason"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_blocks")),
        sa.UniqueConstraint("email_hash", name=op.f("uq_purchase_blocks_email_hash")),
    )


def downgrade() -> None:
    op.drop_table("purchase_blocks")
    op.drop_column("subscriptions", "first_payment")
    op.drop_column("subscriptions", "disputed_at")
    op.drop_column("subscriptions", "stripe_status")
    op.drop_column("subscriptions", "last_event_at")
