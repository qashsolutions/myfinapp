"""plan_events: the Plan history list

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-18

Written by hand from app/models/plan_event.py (owner decision, October 18, 2026). Existing
accounts get their history so far from what is already stored: the trial (its start is the
end less the trial's length), each subscription's start, a pending cancellation, and plans
that have ended. Amounts are left empty for those.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

KINDS = "'trial_started', 'subscribed', 'switched', 'cancelled', 'resumed', 'ended'"


def upgrade() -> None:
    op.create_table(
        "plan_events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("interval", sa.String(8), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=True),
        sa.Column("until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plan_events")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_plan_events_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(f"kind IN ({KINDS})", name=op.f("ck_plan_events_kind")),
    )
    op.create_index(op.f("ix_plan_events_user_id"), "plan_events", ["user_id"])
    op.execute(
        """
        INSERT INTO plan_events (user_id, kind, plan, at)
        SELECT id, 'trial_started', trial_plan,
               trial_ends_at - CASE trial_plan WHEN 'private' THEN interval '45 days'
                                               ELSE interval '8 days' END
        FROM users
        WHERE trial_plan IS NOT NULL AND trial_ends_at IS NOT NULL AND deleted_at IS NULL;

        INSERT INTO plan_events (user_id, kind, plan, interval, at)
        SELECT user_id, 'subscribed', plan, interval, created_at
        FROM subscriptions WHERE plan <> 'free';

        INSERT INTO plan_events (user_id, kind, plan, interval, until, at)
        SELECT user_id, 'cancelled', plan, interval, renews_at, updated_at
        FROM subscriptions WHERE cancel_at_period_end AND status <> 'canceled';

        INSERT INTO plan_events (user_id, kind, plan, interval, at)
        SELECT user_id, 'ended', plan, interval, COALESCE(ends_at, updated_at)
        FROM subscriptions WHERE status IN ('canceled', 'expired');
        """
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_plan_events_user_id"), table_name="plan_events")
    op.drop_table("plan_events")
