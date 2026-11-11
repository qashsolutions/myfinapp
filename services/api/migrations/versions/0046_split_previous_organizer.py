"""split_groups.previous_organizer_member_id (chunk S.6, November 10, 2026)

Corrections, deletions and approvals live in the organizer's own encrypted ledger. When the
organizer leaves (or their account goes), devices still read that member's ledger for them until
someone takes the group over, so a deleted bill never comes back and the group keeps its name.
Takeover records the organizer it took over from too.

Revision ID: 0046
Revises: 0045
Create Date: 2026-11-10

Written by hand from app/models/split.py. A nullable column only, so the build before this one
keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "split_groups",
        sa.Column("previous_organizer_member_id", sa.Uuid(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("split_groups", "previous_organizer_member_id")
