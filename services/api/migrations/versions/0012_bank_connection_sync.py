"""bank_connections: status, last_synced_at, updates_available_at (Phase 3, chunk 3.3)

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-12

Written by hand from app/models/linking.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bank_connections",
        sa.Column("status", sa.String(length=20), server_default="ok", nullable=False),
    )
    op.add_column(
        "bank_connections", sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "bank_connections",
        sa.Column("updates_available_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_bank_connections_status"),
        "bank_connections",
        "status IN ('ok', 'login_required', 'revoked')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_bank_connections_status"), "bank_connections", type_="check")
    op.drop_column("bank_connections", "updates_available_at")
    op.drop_column("bank_connections", "last_synced_at")
    op.drop_column("bank_connections", "status")
