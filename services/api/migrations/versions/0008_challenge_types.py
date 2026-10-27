"""groups.template_key takes the fast-follow 4 challenge types

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-10

Written by hand from app/models/group.py.
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

NEW = "'monthly_savings', 'no_eat_out_week', 'dining_diet', 'no_spend_weekend', 'fifty_two_week'"
OLD = "'monthly_savings'"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_groups_template_key"), "groups", type_="check")
    op.create_check_constraint(op.f("ck_groups_template_key"), "groups", f"template_key IN ({NEW})")


def downgrade() -> None:
    op.execute(f"DELETE FROM groups WHERE template_key NOT IN ({OLD})")
    op.drop_constraint(op.f("ck_groups_template_key"), "groups", type_="check")
    op.create_check_constraint(op.f("ck_groups_template_key"), "groups", f"template_key IN ({OLD})")
