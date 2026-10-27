"""bank_connections.institution_id: spot a second link to the same bank

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-16

Written by hand from app/models/linking.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bank_connections", sa.Column("institution_id", sa.String(length=40), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("bank_connections", "institution_id")
