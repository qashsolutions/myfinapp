"""subscriptions: when the plan last changed, and a refund owed on deletion

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-17

Written by hand from app/models/billing.py. Plan changes happen at once (owner decision,
October 17, 2026): up charges the difference, down leaves the unused part as credit. A
downgrade opens 30 days after the plan started or last changed, so this records the change.
Deleting the account keeps the current month and refunds the rest: the amount is worked out
once and kept here until it is paid, so a retry never refunds twice.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions", sa.Column("plan_changed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("subscriptions", sa.Column("refund_due_cents", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("subscriptions", "refund_due_cents")
    op.drop_column("subscriptions", "plan_changed_at")
