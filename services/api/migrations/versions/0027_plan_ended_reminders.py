"""A plan that ended: daily friendly reminders, and devices keep their data (October 20, 2026)

- users.lapsed_reminded_on: the day the last reminder went out in the 7 days after a plan ended.
- sessions.ended_reason gains 'plan_ended': the account closed because its plan ended (not a
  deletion the person asked for), so the app keeps what is on the device until they decide.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-20

Written by hand from app/models/user.py and app/models/session.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

OLD = (
    "ended_reason IS NULL OR ended_reason IN ('signed_out', 'signed_out_remote', 'account_deleted')"
)
NEW = (
    "ended_reason IS NULL OR ended_reason IN "
    "('signed_out', 'signed_out_remote', 'account_deleted', 'plan_ended')"
)


def upgrade() -> None:
    op.add_column("users", sa.Column("lapsed_reminded_on", sa.Date(), nullable=True))
    op.drop_constraint(op.f("ck_sessions_ended_reason"), "sessions", type_="check")
    op.create_check_constraint(op.f("ck_sessions_ended_reason"), "sessions", NEW)


def downgrade() -> None:
    op.execute(
        "UPDATE sessions SET ended_reason = 'account_deleted' WHERE ended_reason = 'plan_ended'"
    )
    op.drop_constraint(op.f("ck_sessions_ended_reason"), "sessions", type_="check")
    op.create_check_constraint(op.f("ck_sessions_ended_reason"), "sessions", OLD)
    op.drop_column("users", "lapsed_reminded_on")
