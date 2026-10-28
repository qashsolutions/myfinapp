"""A household of two, one household each (October 28, 2026)

- household_members: a partial unique index on user_id where left_at is null, so a person is in
  one household at most whatever a route does (joins and leaves also lock the person, then the
  household).
- households.owner_id: a household whose owner left passes to its longest-standing member, as
  leaving does from now on, so its writes ride the plan of someone still in it.

Before the index, any second live membership a race left behind is closed (the earliest kept).

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-28

Written by hand from app/models/household.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE household_members AS m SET left_at = now()
        FROM (
            SELECT id, row_number() OVER (
                PARTITION BY user_id ORDER BY joined_at, id
            ) AS n
            FROM household_members WHERE left_at IS NULL
        ) AS ranked
        WHERE m.id = ranked.id AND ranked.n > 1
        """
    )
    op.execute(
        """
        UPDATE households AS h SET owner_id = (
            SELECT m.user_id FROM household_members AS m
            WHERE m.household_id = h.id AND m.left_at IS NULL
            ORDER BY m.joined_at, m.id LIMIT 1
        )
        WHERE NOT EXISTS (
            SELECT 1 FROM household_members AS o
            WHERE o.household_id = h.id AND o.user_id = h.owner_id AND o.left_at IS NULL
        )
        AND EXISTS (
            SELECT 1 FROM household_members AS a
            WHERE a.household_id = h.id AND a.left_at IS NULL
        )
        """
    )
    op.create_index(
        "uq_household_members_live_user",
        "household_members",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("left_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_household_members_live_user", table_name="household_members")
