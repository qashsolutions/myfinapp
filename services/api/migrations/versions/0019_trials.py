"""Trials instead of a lasting Free plan (owner decision, October 14, 2026): the trial each
account picked and its end, the notices sent, and one trial per email (trial_claims)

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-14

Written by hand from app/models/user.py and app/models/trial_claim.py.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("trial_plan", sa.String(16), nullable=True))
    op.add_column("users", sa.Column("trial_ends_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users", sa.Column("ending_notice_for", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("lapsed_notice_for", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_users_trial_plan"),
        "users",
        "trial_plan IS NULL OR trial_plan IN ('private', 'connected')",
    )
    op.create_table(
        "trial_claims",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("email_hash", sa.String(64), nullable=False),
        sa.Column("plan", sa.String(16), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trial_claims")),
        sa.UniqueConstraint("email_hash", name=op.f("uq_trial_claims_email_hash")),
    )


def downgrade() -> None:
    op.drop_table("trial_claims")
    op.drop_constraint(op.f("ck_users_trial_plan"), "users", type_="check")
    for column in ("lapsed_notice_for", "ending_notice_for", "trial_ends_at", "trial_plan"):
        op.drop_column("users", column)
