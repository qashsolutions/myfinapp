"""groups, group_members (chunk 1.6)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-10

Written by hand from app/models/{group,group_member}.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


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
        "groups",
        *_row_columns(),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("template_key", sa.String(32), server_default="monthly_savings", nullable=False),
        sa.Column("invite_code", sa.String(8), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_groups")),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_groups_owner_id_users"), ondelete="CASCADE"
        ),
        sa.UniqueConstraint("invite_code", name=op.f("uq_groups_invite_code")),
        sa.CheckConstraint(
            "template_key IN ('monthly_savings')", name=op.f("ck_groups_template_key")
        ),
    )
    op.create_index(op.f("ix_groups_owner_id"), "groups", ["owner_id"])

    op.create_table(
        "group_members",
        *_row_columns(),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("progress_bps", sa.Integer(), server_default="0", nullable=False),
        sa.Column("progress_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reached_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_group_members")),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["groups.id"],
            name=op.f("fk_group_members_group_id_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_group_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("group_id", "user_id", name=op.f("uq_group_members_group_id")),
        sa.CheckConstraint("progress_bps >= 0", name=op.f("ck_group_members_progress_bps")),
    )
    op.create_index(op.f("ix_group_members_group_id"), "group_members", ["group_id"])
    op.create_index(op.f("ix_group_members_user_id"), "group_members", ["user_id"])


def downgrade() -> None:
    op.drop_table("group_members")
    op.drop_table("groups")
