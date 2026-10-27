"""sessions.ended_reason: why a session ended (signed out, signed out from another device,
account deleted), shown in Sign-in & security (October 13, 2026)

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-13

Written by hand from app/models/session.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("ended_reason", sa.String(24), nullable=True))
    op.create_check_constraint(
        op.f("ck_sessions_ended_reason"),
        "sessions",
        "ended_reason IS NULL OR ended_reason IN "
        "('signed_out', 'signed_out_remote', 'account_deleted')",
    )
    # Sessions already ended before this column existed read as "signed out".
    op.execute("UPDATE sessions SET ended_reason = 'signed_out' WHERE revoked_at IS NOT NULL")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_sessions_ended_reason"), "sessions", type_="check")
    op.drop_column("sessions", "ended_reason")
