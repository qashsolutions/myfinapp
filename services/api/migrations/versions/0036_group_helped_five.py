"""group_members.helped: up to 5 "What helped" choices (owner sign-off, October 29, 2026)

Revision ID: 0036
Revises: 0035
Create Date: 2026-10-29

Written by hand from app/models/group_member.py. Up to 5 ids from
stackd_rules/config/helped.yaml (was 3), comma separated; never free text. The column grows to
200 characters so five ids of up to 32 letters and their commas always fit.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_group_members_helped"), "group_members", type_="check")
    op.alter_column(
        "group_members",
        "helped",
        existing_type=sa.String(100),
        type_=sa.String(200),
        existing_nullable=True,
    )
    op.create_check_constraint(
        op.f("ck_group_members_helped"),
        "group_members",
        "helped IS NULL OR helped ~ '^[a-z_]{2,32}(,[a-z_]{2,32}){0,4}$'",
    )


def downgrade() -> None:
    # Answers past three choices keep their first three (in the list's order) before narrowing.
    op.execute(
        "UPDATE group_members"
        " SET helped = array_to_string((string_to_array(helped, ','))[1:3], ',')"
        " WHERE helped IS NOT NULL"
    )
    op.drop_constraint(op.f("ck_group_members_helped"), "group_members", type_="check")
    op.alter_column(
        "group_members",
        "helped",
        existing_type=sa.String(200),
        type_=sa.String(100),
        existing_nullable=True,
    )
    op.create_check_constraint(
        op.f("ck_group_members_helped"),
        "group_members",
        "helped IS NULL OR helped ~ '^[a-z_]{2,32}(,[a-z_]{2,32}){0,2}$'",
    )
