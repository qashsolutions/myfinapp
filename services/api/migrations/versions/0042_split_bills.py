"""split groups, members, invites, issued bill ids, blobs, key handovers, disputes, reports,
mistakes and pay-warning consents; users.split_blocked_at, split_reports_cleared_at and
split_double_check_since (November 8, 2026)

Split bills (owner decisions, November 7–8, 2026; docs/spec.md "Split bills"; invariants
77–79). Nothing here holds an amount, a name or a group's name: those travel as ciphertext.

Revision ID: 0042
Revises: 0041
Create Date: 2026-11-08

Drafted with alembic autogenerate against app/models/split.py and user.py, then read by hand.
New tables and nullable columns only, so the build before this one keeps running on it
(invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "split_groups",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("organizer_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["organizer_id"],
            ["users.id"],
            name=op.f("fk_split_groups_organizer_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_groups")),
    )
    op.create_index(
        op.f("ix_split_groups_organizer_id"), "split_groups", ["organizer_id"], unique=False
    )
    op.create_table(
        "split_mistakes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "kind IN ('invite_declined', 'bill_disputed')", name=op.f("ck_split_mistakes_kind")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_split_mistakes_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_mistakes")),
    )
    op.create_index(op.f("ix_split_mistakes_user_id"), "split_mistakes", ["user_id"], unique=False)
    op.create_table(
        "split_pay_consents",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.String(length=16), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_split_pay_consents_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_pay_consents")),
    )
    op.create_index(
        op.f("ix_split_pay_consents_user_id"), "split_pay_consents", ["user_id"], unique=False
    )
    op.create_table(
        "split_bills",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("counted_for", sa.Uuid(), nullable=True),
        sa.Column("counted_day", sa.Date(), nullable=False),
        sa.ForeignKeyConstraint(
            ["counted_for"],
            ["users.id"],
            name=op.f("fk_split_bills_counted_for_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_split_bills_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_bills_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_bills")),
    )
    op.create_index(
        op.f("ix_split_bills_counted_for"), "split_bills", ["counted_for"], unique=False
    )
    op.create_index(op.f("ix_split_bills_created_by"), "split_bills", ["created_by"], unique=False)
    op.create_index(op.f("ix_split_bills_group_id"), "split_bills", ["group_id"], unique=False)
    op.create_table(
        "split_invites",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("invited_by", sa.Uuid(), nullable=True),
        sa.Column("email_hash", sa.String(length=64), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_by", sa.Uuid(), nullable=True),
        sa.Column("declined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_invites_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["invited_by"],
            ["users.id"],
            name=op.f("fk_split_invites_invited_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_invites")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_split_invites_token_hash")),
    )
    op.create_index(
        op.f("ix_split_invites_email_hash"), "split_invites", ["email_hash"], unique=False
    )
    op.create_index(op.f("ix_split_invites_group_id"), "split_invites", ["group_id"], unique=False)
    op.create_index(
        op.f("ix_split_invites_invited_by"), "split_invites", ["invited_by"], unique=False
    )
    op.create_table(
        "split_members",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_members_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_split_members_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_members")),
    )
    op.create_index(op.f("ix_split_members_group_id"), "split_members", ["group_id"], unique=False)
    op.create_index(op.f("ix_split_members_user_id"), "split_members", ["user_id"], unique=False)
    op.create_index(
        "uq_split_members_live",
        "split_members",
        ["group_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )
    op.create_table(
        "split_reports",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("organizer_id", sa.Uuid(), nullable=False),
        sa.Column("reporter_id", sa.Uuid(), nullable=True),
        sa.Column("group_id", sa.Uuid(), nullable=True),
        sa.Column("reason", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "reason IN ('dont_know', 'not_owed', 'pushy', 'other')",
            name=op.f("ck_split_reports_reason"),
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_reports_group_id_split_groups"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["organizer_id"],
            ["users.id"],
            name=op.f("fk_split_reports_organizer_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reporter_id"],
            ["users.id"],
            name=op.f("fk_split_reports_reporter_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_reports")),
    )
    op.create_index(
        op.f("ix_split_reports_organizer_id"), "split_reports", ["organizer_id"], unique=False
    )
    op.create_index(
        op.f("ix_split_reports_reporter_id"), "split_reports", ["reporter_id"], unique=False
    )
    op.create_table(
        "split_blobs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("member_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind IN ('ledger', 'profile')", name=op.f("ck_split_blobs_kind")),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_blobs_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["member_id"],
            ["split_members.id"],
            name=op.f("fk_split_blobs_member_id_split_members"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_blobs")),
        sa.UniqueConstraint("group_id", "member_id", "kind", name=op.f("uq_split_blobs_group_id")),
    )
    op.create_index(op.f("ix_split_blobs_group_id"), "split_blobs", ["group_id"], unique=False)
    op.create_index(op.f("ix_split_blobs_member_id"), "split_blobs", ["member_id"], unique=False)
    op.create_table(
        "split_disputes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("bill_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["bill_id"],
            ["split_bills.id"],
            name=op.f("fk_split_disputes_bill_id_split_bills"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_disputes_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_split_disputes_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_disputes")),
    )
    op.create_index(op.f("ix_split_disputes_bill_id"), "split_disputes", ["bill_id"], unique=False)
    op.create_index(
        op.f("ix_split_disputes_group_id"), "split_disputes", ["group_id"], unique=False
    )
    op.create_index(op.f("ix_split_disputes_user_id"), "split_disputes", ["user_id"], unique=False)
    op.create_index(
        "uq_split_disputes_open",
        "split_disputes",
        ["bill_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("closed_at IS NULL"),
    )
    op.create_table(
        "split_keys",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("member_id", sa.Uuid(), nullable=False),
        sa.Column("device_key_id", sa.String(length=64), nullable=False),
        sa.Column("public_key", sa.LargeBinary(), nullable=False),
        sa.Column("wrapped_key", sa.LargeBinary(), nullable=True),
        sa.Column("wrapped_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["split_groups.id"],
            name=op.f("fk_split_keys_group_id_split_groups"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["member_id"],
            ["split_members.id"],
            name=op.f("fk_split_keys_member_id_split_members"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_split_keys")),
        sa.UniqueConstraint(
            "group_id", "member_id", "device_key_id", name=op.f("uq_split_keys_group_id")
        ),
    )
    op.create_index(op.f("ix_split_keys_group_id"), "split_keys", ["group_id"], unique=False)
    op.create_index(op.f("ix_split_keys_member_id"), "split_keys", ["member_id"], unique=False)
    op.add_column("users", sa.Column("split_blocked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users", sa.Column("split_reports_cleared_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("split_double_check_since", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "split_double_check_since")
    op.drop_column("users", "split_reports_cleared_at")
    op.drop_column("users", "split_blocked_at")
    op.drop_index(op.f("ix_split_keys_member_id"), table_name="split_keys")
    op.drop_index(op.f("ix_split_keys_group_id"), table_name="split_keys")
    op.drop_table("split_keys")
    op.drop_index(
        "uq_split_disputes_open",
        table_name="split_disputes",
        postgresql_where=sa.text("closed_at IS NULL"),
    )
    op.drop_index(op.f("ix_split_disputes_user_id"), table_name="split_disputes")
    op.drop_index(op.f("ix_split_disputes_group_id"), table_name="split_disputes")
    op.drop_index(op.f("ix_split_disputes_bill_id"), table_name="split_disputes")
    op.drop_table("split_disputes")
    op.drop_index(op.f("ix_split_blobs_member_id"), table_name="split_blobs")
    op.drop_index(op.f("ix_split_blobs_group_id"), table_name="split_blobs")
    op.drop_table("split_blobs")
    op.drop_index(op.f("ix_split_reports_reporter_id"), table_name="split_reports")
    op.drop_index(op.f("ix_split_reports_organizer_id"), table_name="split_reports")
    op.drop_table("split_reports")
    op.drop_index(
        "uq_split_members_live",
        table_name="split_members",
        postgresql_where=sa.text("left_at IS NULL"),
    )
    op.drop_index(op.f("ix_split_members_user_id"), table_name="split_members")
    op.drop_index(op.f("ix_split_members_group_id"), table_name="split_members")
    op.drop_table("split_members")
    op.drop_index(op.f("ix_split_invites_invited_by"), table_name="split_invites")
    op.drop_index(op.f("ix_split_invites_group_id"), table_name="split_invites")
    op.drop_index(op.f("ix_split_invites_email_hash"), table_name="split_invites")
    op.drop_table("split_invites")
    op.drop_index(op.f("ix_split_bills_group_id"), table_name="split_bills")
    op.drop_index(op.f("ix_split_bills_created_by"), table_name="split_bills")
    op.drop_index(op.f("ix_split_bills_counted_for"), table_name="split_bills")
    op.drop_table("split_bills")
    op.drop_index(op.f("ix_split_pay_consents_user_id"), table_name="split_pay_consents")
    op.drop_table("split_pay_consents")
    op.drop_index(op.f("ix_split_mistakes_user_id"), table_name="split_mistakes")
    op.drop_table("split_mistakes")
    op.drop_index(op.f("ix_split_groups_organizer_id"), table_name="split_groups")
    op.drop_table("split_groups")
