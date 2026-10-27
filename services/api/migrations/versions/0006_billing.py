"""subscriptions, entitlements, billing_events (chunk 1.14)

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-10

Written by hand from app/models/billing.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


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


def upgrade() -> None:
    op.create_table(
        "subscriptions",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("external_id", sa.String(120), nullable=True),
        sa.Column("customer_id", sa.String(120), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("interval", sa.String(8), nullable=True),
        sa.Column("renews_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_at_period_end", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_subscriptions")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_subscriptions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("external_id", name=op.f("uq_subscriptions_external_id")),
        sa.CheckConstraint(
            _one_of("plan", ("free", "private", "connected", "founding")),
            name=op.f("ck_subscriptions_plan"),
        ),
        sa.CheckConstraint(
            _one_of("source", ("stripe", "apple", "google")), name=op.f("ck_subscriptions_source")
        ),
        sa.CheckConstraint(
            _one_of("status", ("active", "past_due", "canceled", "expired", "incomplete")),
            name=op.f("ck_subscriptions_status"),
        ),
    )
    op.create_index(op.f("ix_subscriptions_user_id"), "subscriptions", ["user_id"])

    op.create_table(
        "entitlements",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("value", sa.String(40), nullable=False),
        sa.Column("derived_from", sa.Uuid(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_entitlements")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_entitlements_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("user_id", "key", name=op.f("uq_entitlements_user_id")),
    )
    op.create_index(op.f("ix_entitlements_user_id"), "entitlements", ["user_id"])

    op.create_table(
        "billing_events",
        *_row_columns(),
        sa.Column("event_id", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_billing_events")),
        sa.UniqueConstraint("event_id", name=op.f("uq_billing_events_event_id")),
    )


def downgrade() -> None:
    for table in ("billing_events", "entitlements", "subscriptions"):
        op.drop_table(table)
