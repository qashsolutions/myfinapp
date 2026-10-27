"""A lost dispute is final (October 25, 2026)

- subscriptions.dispute_lost_at: the bank decided the dispute for the person. The plan has
  ended and the account lapses as usual; `disputed_at` stays, so deleting the account still
  refunds nothing more.

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-25

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions", sa.Column("dispute_lost_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("subscriptions", "dispute_lost_at")
