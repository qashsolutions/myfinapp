"""Split ledgers in monthly pages (chunk S.5, November 9, 2026): split_blobs.kind takes
`ledger:YYYY-MM` beside `ledger` and `profile`, so a member's ledger grows a page a month instead
of filling one 256 KB blob.

Revision ID: 0044
Revises: 0043
Create Date: 2026-11-09

Written by hand from app/models/split.py. A wider check only, so the build before this one keeps
running on it (invariant 31).
"""

from __future__ import annotations

from alembic import op

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None

BEFORE = "kind IN ('ledger', 'profile')"
AFTER = "kind IN ('ledger', 'profile') OR kind ~ '^ledger:[0-9]{4}-(0[1-9]|1[0-2])$'"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_split_blobs_kind"), "split_blobs", type_="check")
    op.create_check_constraint(op.f("ck_split_blobs_kind"), "split_blobs", AFTER)


def downgrade() -> None:
    op.execute("DELETE FROM split_blobs WHERE kind LIKE 'ledger:%'")
    op.drop_constraint(op.f("ck_split_blobs_kind"), "split_blobs", type_="check")
    op.create_check_constraint(op.f("ck_split_blobs_kind"), "split_blobs", BEFORE)
