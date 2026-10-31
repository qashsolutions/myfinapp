"""subscriptions: a partial index for the Founding count (October 31, 2026)

The load test found `entitlements.founding_taken` reading every subscription row on each Plan
screen, checkout and pricing-page read: a cost that grows with every person who subscribes. The
index holds only Founding rows (at most a few hundred).

Revision ID: 0042
Revises: 0041
Create Date: 2026-10-31

Written by hand from app/models/billing.py. An index only, so the build before this one keeps
running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_subscriptions_founding",
        "subscriptions",
        ["status"],
        unique=False,
        postgresql_where=sa.text("plan = 'founding'"),
    )


def downgrade() -> None:
    op.drop_index("ix_subscriptions_founding", table_name="subscriptions")
