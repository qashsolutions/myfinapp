"""split_activity: split bills join the alert types; a guest's bill waits for the organizer's
OK (split_bills.status, split_groups.guests_can_add, mistake kind bill_declined); a lapsed
account in a split group stays a guest (users.split_guest_notice_for) (November 8, 2026)

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

import sqlalchemy as sa
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


MISTAKES_BEFORE = "kind IN ('invite_declined', 'bill_disputed')"
MISTAKES_AFTER = "kind IN ('invite_declined', 'bill_disputed', 'bill_declined')"


def upgrade() -> None:
    _set(AFTER)
    op.add_column(
        "split_bills",
        sa.Column("status", sa.String(16), server_default="approved", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_split_bills_status"),
        "split_bills",
        "status IN ('approved', 'pending', 'declined')",
    )
    op.alter_column("split_bills", "counted_day", existing_type=sa.Date(), nullable=True)
    op.add_column(
        "split_groups",
        sa.Column("guests_can_add", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column(
        "users", sa.Column("split_guest_notice_for", sa.DateTime(timezone=True), nullable=True)
    )
    op.drop_constraint(op.f("ck_split_mistakes_kind"), "split_mistakes", type_="check")
    op.create_check_constraint(op.f("ck_split_mistakes_kind"), "split_mistakes", MISTAKES_AFTER)


def downgrade() -> None:
    op.execute("DELETE FROM split_mistakes WHERE kind = 'bill_declined'")
    op.drop_constraint(op.f("ck_split_mistakes_kind"), "split_mistakes", type_="check")
    op.create_check_constraint(op.f("ck_split_mistakes_kind"), "split_mistakes", MISTAKES_BEFORE)
    op.drop_column("users", "split_guest_notice_for")
    op.drop_column("split_groups", "guests_can_add")
    op.execute("DELETE FROM split_bills WHERE status <> 'approved'")
    op.alter_column("split_bills", "counted_day", existing_type=sa.Date(), nullable=False)
    op.drop_constraint(op.f("ck_split_bills_status"), "split_bills", type_="check")
    op.drop_column("split_bills", "status")
    for table in TABLES:
        op.execute(f"DELETE FROM {table} WHERE type = 'split_activity'")
    _set(BEFORE)
