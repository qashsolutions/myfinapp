"""budget_pace: a budget alert in the moment joins the alert types (October 28, 2026)

Revision ID: 0034
Revises: 0033
Create Date: 2026-10-28

Written by hand from app/models/notification.py. The type CHECK constraints on
notification_prefs and alert_schedule gain `budget_pace`; its key is
`budget:<YYYY-MM>:<16-letter tag>:<level bps>`, never a category or an amount.
"""

from __future__ import annotations

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None

BEFORE = (
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "group_activity",
    "weekly_recap",
)
AFTER = (*BEFORE, "budget_pace")
TABLES = ("notification_prefs", "alert_schedule")


def _one_of(values: tuple[str, ...]) -> str:
    return f"type IN ({', '.join(repr(v) for v in values)})"


def _set(values: tuple[str, ...]) -> None:
    for table in TABLES:
        op.drop_constraint(op.f(f"ck_{table}_type"), table, type_="check")
        op.create_check_constraint(op.f(f"ck_{table}_type"), table, _one_of(values))


def upgrade() -> None:
    _set(AFTER)


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DELETE FROM {table} WHERE type = 'budget_pace'")
    _set(BEFORE)
