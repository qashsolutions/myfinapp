"""notification_prefs.delivery: low balance, milestones and group activity as one daily summary

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-18

Written by hand from app/models/notification.py. Null means each alert goes out as it happens;
"daily" holds them for one summary at the preference's `time_of_day`.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notification_prefs", sa.Column("delivery", sa.String(8), nullable=True))
    op.create_check_constraint(
        op.f("ck_notification_prefs_delivery"),
        "notification_prefs",
        "delivery IN ('instant', 'daily')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_notification_prefs_delivery"), "notification_prefs", type_="check")
    op.drop_column("notification_prefs", "delivery")
