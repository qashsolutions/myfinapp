"""split_activity: split bills join the alert types (November 8, 2026)

Revision ID: 0043
Revises: 0042
Create Date: 2026-11-08

Written by hand from app/models/notification.py. The type CHECK constraints on
notification_prefs and alert_schedule gain `split_activity`; its keys are
`split:bill:<group>:<bill>:<user>`, `split:join:<group>:<member>:<user>`,
`split:dispute:<group>:<bill>:<user>` and `split:remind:<group>:<member>:<date>`: ids and a date,
never a name or an amount. A wider check only, so the build before this one keeps running on it
(invariant 31).
"""

from __future__ import annotations

from alembic import op

revision = "0043"
down_revision = "0042"
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
    "budget_pace",
)
AFTER = (*BEFORE, "split_activity")
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
        op.execute(f"DELETE FROM {table} WHERE type = 'split_activity'")
    _set(BEFORE)
