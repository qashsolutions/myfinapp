"""bank_connections.status adds revoke_pending; link_sessions.connection_id (chunk 3.4)

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-12

Written by hand from app/models/linking.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_bank_connections_status"), "bank_connections", type_="check")
    op.create_check_constraint(
        op.f("ck_bank_connections_status"),
        "bank_connections",
        "status IN ('ok', 'login_required', 'revoked', 'revoke_pending')",
    )
    op.add_column("link_sessions", sa.Column("connection_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_link_sessions_connection_id_bank_connections"),
        "link_sessions",
        "bank_connections",
        ["connection_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_link_sessions_connection_id_bank_connections"), "link_sessions", type_="foreignkey"
    )
    op.drop_column("link_sessions", "connection_id")
    op.execute("DELETE FROM bank_connections WHERE status = 'revoke_pending'")
    op.drop_constraint(op.f("ck_bank_connections_status"), "bank_connections", type_="check")
    op.create_check_constraint(
        op.f("ck_bank_connections_status"),
        "bank_connections",
        "status IN ('ok', 'login_required', 'revoked')",
    )
