"""sessions.link_unlocked_at; group_members.removed_at (October 29, 2026)

- sessions.link_unlocked_at (invariant 44): a computer signed in by Link with your phone opens
  unlocked from this time, but it has passed no passkey check of its own, so
  `passkey_verified_at` stays empty and every step-up route asks for one on the computer first.
- group_members.removed_at (invariant 45): the owner removing a member is not the member
  leaving (only the owner removes, and the audit log says who). A removed member stays out
  (403 `removed` on lookup and join, whatever the code); someone who left may come back.

Revision ID: 0038
Revises: 0037
Create Date: 2026-10-29

Written by hand from app/models/session.py and app/models/group_member.py. Nullable columns
only, so the build before this one keeps running on it (invariant 31).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions", sa.Column("link_unlocked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "group_members", sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("group_members", "removed_at")
    op.drop_column("sessions", "link_unlocked_at")
