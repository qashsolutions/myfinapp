"""split_invites.reminded_at (November 11, 2026)

The organizer reminds someone whose invite is waiting instead of inviting the same inbox twice:
once a day per invite, with a new link and the same 7 days. The address still comes from the
organizer's device each time; the server keeps only its hash.

Revision ID: 0047
Revises: 0046
Create Date: 2026-11-11

Written by hand from app/models/split.py. A nullable column only, so the build before this one
keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "split_invites", sa.Column("reminded_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("split_invites", "reminded_at")
