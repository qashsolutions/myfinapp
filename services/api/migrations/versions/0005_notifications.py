"""notification_prefs, notification_settings, push_subscriptions, notification_log,
alert_schedule (chunk 1.13)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-10

Written by hand from app/models/notification.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

TYPES = (
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "group_activity",
    "weekly_recap",
)


def _one_of(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _row_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def _user_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], name=op.f(f"fk_{table}_user_id_users"), ondelete="CASCADE"
    )


def upgrade() -> None:
    op.create_table(
        "notification_prefs",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("time_of_day", sa.String(5), nullable=True),
        sa.Column("days", sa.String(32), nullable=True),
        sa.Column("lead_days", sa.Integer(), nullable=True),
        sa.Column("threshold", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification_prefs")),
        _user_fk("notification_prefs"),
        sa.UniqueConstraint("user_id", "type", name=op.f("uq_notification_prefs_user_id")),
        sa.CheckConstraint(_one_of("type", TYPES), name=op.f("ck_notification_prefs_type")),
    )
    op.create_index(op.f("ix_notification_prefs_user_id"), "notification_prefs", ["user_id"])

    op.create_table(
        "notification_settings",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("quiet_start", sa.String(5), server_default="21:00", nullable=False),
        sa.Column("quiet_end", sa.String(5), server_default="08:00", nullable=False),
        sa.Column("daily_max", sa.Integer(), server_default="3", nullable=False),
        sa.Column("paused_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone", sa.String(64), server_default="UTC", nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification_settings")),
        _user_fk("notification_settings"),
        sa.UniqueConstraint("user_id", name=op.f("uq_notification_settings_user_id")),
    )

    op.create_table(
        "push_subscriptions",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("platform", sa.String(16), server_default="web", nullable=False),
        sa.Column("endpoint_hash", sa.String(64), nullable=False),
        sa.Column("payload_encrypted", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.String(120), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_push_subscriptions")),
        _user_fk("push_subscriptions"),
        sa.UniqueConstraint("endpoint_hash", name=op.f("uq_push_subscriptions_endpoint_hash")),
        sa.CheckConstraint(
            _one_of("platform", ("web", "ios", "android")),
            name=op.f("ck_push_subscriptions_platform"),
        ),
    )
    op.create_index(op.f("ix_push_subscriptions_user_id"), "push_subscriptions", ["user_id"])

    op.create_table(
        "notification_log",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("dedupe_key", sa.String(200), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification_log")),
        _user_fk("notification_log"),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_notification_log_dedupe_key")),
        sa.CheckConstraint(
            _one_of("channel", ("push", "email", "summary")),
            name=op.f("ck_notification_log_channel"),
        ),
    )
    op.create_index(op.f("ix_notification_log_user_id"), "notification_log", ["user_id"])

    op.create_table(
        "alert_schedule",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("generic_label", sa.String(80), nullable=False),
        sa.Column("dedupe_key", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), server_default="pending", nullable=False),
        sa.Column("from_device", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alert_schedule")),
        _user_fk("alert_schedule"),
        sa.UniqueConstraint("user_id", "dedupe_key", name=op.f("uq_alert_schedule_user_id")),
        sa.CheckConstraint(_one_of("type", TYPES), name=op.f("ck_alert_schedule_type")),
        sa.CheckConstraint(
            _one_of("status", ("pending", "deferred", "summary", "sent", "skipped")),
            name=op.f("ck_alert_schedule_status"),
        ),
    )
    op.create_index(op.f("ix_alert_schedule_user_id"), "alert_schedule", ["user_id"])
    op.create_index(op.f("ix_alert_schedule_due_at"), "alert_schedule", ["due_at"])


def downgrade() -> None:
    for table in (
        "alert_schedule",
        "notification_log",
        "push_subscriptions",
        "notification_settings",
        "notification_prefs",
    ):
        op.drop_table(table)
