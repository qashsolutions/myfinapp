"""notification_prefs.channel: the weekly recap by push, email or both (fast-follow 6)

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-10

Written by hand from app/models/notification.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notification_prefs", sa.Column("channel", sa.String(8), nullable=True))
    op.create_check_constraint(
        op.f("ck_notification_prefs_channel"),
        "notification_prefs",
        "channel IN ('push', 'email', 'both')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_notification_prefs_channel"), "notification_prefs", type_="check")
    op.drop_column("notification_prefs", "channel")
