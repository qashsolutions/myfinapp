"""subscriptions.founding_reminded_days: Founding reminders go once each (October 28, 2026)

As a Founding membership's 4 years end, an email and a push go 30, 7 and 1 day before
(plans.yaml `founding.reminder_days_before`); this keeps the last one sent for the term.

Revision ID: 0033
Revises: 0032
Create Date: 2026-10-28

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("subscriptions", sa.Column("founding_reminded_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("subscriptions", "founding_reminded_days")
