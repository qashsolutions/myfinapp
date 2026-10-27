"""webauthn_challenges for passkey sign-in: kind 'signin', with no user or session yet
(October 13, 2026: a returning user signs in with a synced passkey, no email code)

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-13

Written by hand from app/models/webauthn_challenge.py.
"""

from __future__ import annotations

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("webauthn_challenges", "user_id", nullable=True)
    op.alter_column("webauthn_challenges", "session_id", nullable=True)
    op.drop_constraint(op.f("ck_webauthn_challenges_kind"), "webauthn_challenges", type_="check")
    op.create_check_constraint(
        op.f("ck_webauthn_challenges_kind"),
        "webauthn_challenges",
        "kind IN ('register', 'assert', 'signin')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM webauthn_challenges WHERE kind = 'signin'")
    op.drop_constraint(op.f("ck_webauthn_challenges_kind"), "webauthn_challenges", type_="check")
    op.create_check_constraint(
        op.f("ck_webauthn_challenges_kind"), "webauthn_challenges", "kind IN ('register', 'assert')"
    )
    op.alter_column("webauthn_challenges", "session_id", nullable=False)
    op.alter_column("webauthn_challenges", "user_id", nullable=False)
