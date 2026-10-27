"""purchase_consents.kind: what was agreed to, a purchase, a plan change or a cancellation

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-18

Written by hand from app/models/billing.py. Cancelling asks for the same tick box as buying
(owner decision, October 18, 2026), and the words shown are kept the same way; `kind` tells
the three apart. Rows from before this are purchases or changes; both stay 'purchase'.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "purchase_consents",
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="purchase"),
    )
    op.create_check_constraint(
        "consent_kind", "purchase_consents", "kind IN ('purchase', 'change', 'cancel')"
    )


def downgrade() -> None:
    op.drop_constraint("consent_kind", "purchase_consents", type_="check")
    op.drop_column("purchase_consents", "kind")
