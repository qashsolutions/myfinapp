"""sessions.locked_at: the app's screen lock reaches the server (October 28, 2026)

When the app locks its screen it calls POST /api/auth/lock, which stamps `locked_at`; the session
is then locked until the next passkey check clears it, whatever the idle clock says.

Revision ID: 0032
Revises: 0031
Create Date: 2026-10-28

Written by hand from app/models/session.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "locked_at")
