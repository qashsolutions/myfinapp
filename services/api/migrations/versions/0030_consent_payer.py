"""A purchase block follows the person (October 27, 2026)

- purchase_consents.inbox_key: the keyed pseudonym of the inbox that agreed, in the form
  purchase blocks use (canonical: +tags and Gmail dots dropped), so a lost dispute or a fraud
  refund can block the inbox after the account is deleted and its address tombstoned.
- purchase_consents.stripe_customer_id: the Stripe customer the purchase was paid through, so a
  dispute that arrives after the purge still finds the inbox.
Both are filled from now on, and for older rows when their account is deleted.

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-27

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("purchase_consents", sa.Column("inbox_key", sa.String(64), nullable=True))
    op.add_column(
        "purchase_consents", sa.Column("stripe_customer_id", sa.String(64), nullable=True)
    )
    op.create_index(
        "ix_purchase_consents_stripe_customer_id", "purchase_consents", ["stripe_customer_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_purchase_consents_stripe_customer_id", table_name="purchase_consents")
    op.drop_column("purchase_consents", "stripe_customer_id")
    op.drop_column("purchase_consents", "inbox_key")
