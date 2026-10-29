"""group_members.helped: "What helped" in challenges, from one fixed list (October 28, 2026)

Revision ID: 0035
Revises: 0034
Create Date: 2026-10-28

Written by hand from app/models/group_member.py. Up to 3 ids from
stackd_rules/config/helped.yaml, comma separated; never free text. The group only ever sees
totals, once at least 2 members answered.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("group_members", sa.Column("helped", sa.String(100), nullable=True))
    op.create_check_constraint(
        op.f("ck_group_members_helped"),
        "group_members",
        "helped IS NULL OR helped ~ '^[a-z_]{2,32}(,[a-z_]{2,32}){0,2}$'",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_group_members_helped"), "group_members", type_="check")
    op.drop_column("group_members", "helped")
