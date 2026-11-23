"""bank_connections.new_accounts_at and link_sessions.add_accounts (November 23, 2026)

Plaid's NEW_ACCOUNTS_AVAILABLE webhook says the person opened an account at a bank they already
linked. The connection remembers when, so Linked banks can offer "Add them"; a link session
started from that offer opens Plaid's update mode with account selection, and finishing it
clears the mark (invariant 96).

Revision ID: 0048
Revises: 0047
Create Date: 2026-11-23

Written by hand from app/models/linking.py. A nullable column and one with a default, so the
build before this one keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0048"
down_revision = "0047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bank_connections",
        sa.Column("new_accounts_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "link_sessions",
        sa.Column("add_accounts", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("link_sessions", "add_accounts")
    op.drop_column("bank_connections", "new_accounts_at")
