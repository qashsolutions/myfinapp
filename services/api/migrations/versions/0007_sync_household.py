"""backup_keys, backups, households, household_members, household_invites, household_blobs
(chunk 1.16)

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10

Written by hand from app/models/backup.py and app/models/household.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
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


def _user_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], name=op.f(f"fk_{table}_user_id_users"), ondelete="CASCADE"
    )


def upgrade() -> None:
    op.create_table(
        "backup_keys",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("recovery_wrapped", sa.String(512), nullable=False),
        sa.Column("recovery_salt", sa.String(128), nullable=False),
        sa.Column("passkey_wrapped", sa.String(512), nullable=True),
        sa.Column("passkey_salt", sa.String(128), nullable=True),
        sa.Column("passkey_credential_id", sa.String(512), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_backup_keys")),
        _user_fk("backup_keys"),
        sa.UniqueConstraint("user_id", name=op.f("uq_backup_keys_user_id")),
    )
    op.create_table(
        "backups",
        *_row_columns(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("blob_key", sa.String(200), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("snapshot_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_label", sa.String(80), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_backups")),
        _user_fk("backups"),
        sa.UniqueConstraint("blob_key", name=op.f("uq_backups_blob_key")),
    )
    op.create_index(op.f("ix_backups_user_id"), "backups", ["user_id"])

    op.create_table(
        "households",
        *_row_columns(),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_households")),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name=op.f("fk_households_owner_id_users"),
            ondelete="CASCADE",
        ),
    )
    op.create_index(op.f("ix_households_owner_id"), "households", ["owner_id"])

    op.create_table(
        "household_members",
        *_row_columns(),
        sa.Column("household_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_household_members")),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_members_household_id_households"),
            ondelete="CASCADE",
        ),
        _user_fk("household_members"),
    )
    op.create_index(
        op.f("ix_household_members_household_id"), "household_members", ["household_id"]
    )
    op.create_index(op.f("ix_household_members_user_id"), "household_members", ["user_id"])

    op.create_table(
        "household_invites",
        *_row_columns(),
        sa.Column("household_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(12), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_by", sa.Uuid(), nullable=True),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_household_invites")),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_invites_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("code", name=op.f("uq_household_invites_code")),
    )
    op.create_index(
        op.f("ix_household_invites_household_id"), "household_invites", ["household_id"]
    )

    op.create_table(
        "household_blobs",
        *_row_columns(),
        sa.Column("household_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_household_blobs")),
        sa.ForeignKeyConstraint(
            ["household_id"],
            ["households.id"],
            name=op.f("fk_household_blobs_household_id_households"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_household_blobs_author_id_users"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "household_id", "author_id", "kind", name=op.f("uq_household_blobs_household_id")
        ),
        sa.CheckConstraint("kind IN ('jars', 'summary')", name=op.f("ck_household_blobs_kind")),
    )
    op.create_index(op.f("ix_household_blobs_household_id"), "household_blobs", ["household_id"])
    op.create_index(op.f("ix_household_blobs_author_id"), "household_blobs", ["author_id"])


def downgrade() -> None:
    for table in (
        "household_blobs",
        "household_invites",
        "household_members",
        "households",
        "backups",
        "backup_keys",
    ):
        op.drop_table(table)
