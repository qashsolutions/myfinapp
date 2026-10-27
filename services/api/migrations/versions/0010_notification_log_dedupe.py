"""notification_log dedupe is per user, not global (chunk 2.3 found it)

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-11

Device dedupe keys are the same string for every user by construction ("recap:<date>"), so a
global unique constraint let the first user's send suppress everyone else's. Written by hand
from app/models/notification.py.
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("uq_notification_log_dedupe_key"), "notification_log", type_="unique")
    op.create_unique_constraint(
        op.f("uq_notification_log_user_id"), "notification_log", ["user_id", "dedupe_key"]
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM notification_log a USING notification_log b "
        "WHERE a.dedupe_key = b.dedupe_key AND a.id > b.id"
    )
    op.drop_constraint(op.f("uq_notification_log_user_id"), "notification_log", type_="unique")
    op.create_unique_constraint(
        op.f("uq_notification_log_dedupe_key"), "notification_log", ["dedupe_key"]
    )
