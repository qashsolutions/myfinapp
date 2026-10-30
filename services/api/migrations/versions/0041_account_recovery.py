"""account_recoveries, users.recovery_partner_id and recovered_at, sessions ended 'recovered'
(October 30, 2026)

Getting back in without a passkey (owner decision, October 30, 2026; invariant 74): a request
that is ready after 24 hours or when the household partner approves; the partner the person lets
approve; when an email-only recovery last finished (a day's hold on the most
sensitive actions); and the reason a session ends when a recovery finishes.

Revision ID: 0041
Revises: 0040
Create Date: 2026-10-30

Written by hand from app/models/recovery.py, user.py and session.py. A new table, nullable or
defaulted columns and a wider check only, so the build before this one keeps running on it
(invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None

OLD = (
    "ended_reason IS NULL OR ended_reason IN "
    "('signed_out', 'signed_out_remote', 'account_deleted', 'plan_ended')"
)
NEW = (
    "ended_reason IS NULL OR ended_reason IN "
    "('signed_out', 'signed_out_remote', 'account_deleted', 'plan_ended', 'recovered')"
)


def upgrade() -> None:
    op.create_table(
        "account_recoveries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(16), server_default="waiting", nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("device_label", sa.String(80), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("partner_id", sa.Uuid(), nullable=True),
        sa.Column("partner_code_hash", sa.String(64), nullable=True),
        sa.Column("partner_approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_session_id", sa.Uuid(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_reason", sa.String(16), nullable=True),
        sa.CheckConstraint(
            "status IN ('waiting', 'done', 'cancelled')", name=op.f("ck_account_recoveries_status")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_account_recoveries_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
            name=op.f("fk_account_recoveries_session_id_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["approved_session_id"],
            ["sessions.id"],
            name=op.f("fk_account_recoveries_approved_session_id_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["partner_id"],
            ["users.id"],
            name=op.f("fk_account_recoveries_partner_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_account_recoveries")),
    )
    op.create_index(
        op.f("ix_account_recoveries_user_id"), "account_recoveries", ["user_id"], unique=False
    )
    op.create_index(
        "uq_account_recoveries_waiting",
        "account_recoveries",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'waiting'"),
    )
    op.add_column("users", sa.Column("recovery_partner_id", sa.Uuid(), nullable=True))
    op.add_column("users", sa.Column("recovered_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_constraint(op.f("ck_sessions_ended_reason"), "sessions", type_="check")
    op.create_check_constraint(op.f("ck_sessions_ended_reason"), "sessions", NEW)


def downgrade() -> None:
    op.execute("UPDATE sessions SET ended_reason = 'signed_out' WHERE ended_reason = 'recovered'")
    op.drop_constraint(op.f("ck_sessions_ended_reason"), "sessions", type_="check")
    op.create_check_constraint(op.f("ck_sessions_ended_reason"), "sessions", OLD)
    op.drop_column("users", "recovered_at")
    op.drop_column("users", "recovery_partner_id")
    op.drop_index("uq_account_recoveries_waiting", table_name="account_recoveries")
    op.drop_index(op.f("ix_account_recoveries_user_id"), table_name="account_recoveries")
    op.drop_table("account_recoveries")
