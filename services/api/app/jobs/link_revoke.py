"""Revoke bank connections nobody should still hold (Phase 3, chunk 3.4; docs/security/linking.md).

`stackd-api revoke-links` runs this on a schedule:

1. **Pending:** connections marked revoke_pending (Disconnect or deletion while the provider was
   down) and every connection of a deleted account are revoked at the provider and deleted. One
   the provider still refuses stays for the next run.
2. **Dormant:** a live connection not used for `STACKD_LINK_DORMANT_DAYS` (60, the spec) is
   revoked the same way, audited as BANK_AUTO_REVOKED, and its owner gets an always-on email
   saying what happened and that their accounts and entries stay on the device.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.linking import plaid, token_vault
from app.models.linking import BankConnection
from app.models.user import User
from app.routers.linking import revoke
from app.security.audit import AuditAction, record
from app.services.security_alerts import SecurityEvent, send_alert


def revoke_due(db: DbSession, *, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    counts = {"pending_revoked": 0, "dormant_revoked": 0, "failed": 0}
    if not plaid.configured():
        return counts

    pending = db.scalars(
        select(BankConnection)
        .join(User, User.id == BankConnection.user_id)
        .where(or_(BankConnection.status == "revoke_pending", User.deleted_at.is_not(None)))
    ).all()
    for row in pending:
        try:
            revoke(db, row)
            db.commit()
            counts["pending_revoked"] += 1
        except (plaid.LinkError, token_vault.VaultError):
            db.rollback()
            counts["failed"] += 1

    cutoff = now - timedelta(days=get_settings().link_dormant_days)
    dormant = db.execute(
        select(BankConnection, User)
        .join(User, User.id == BankConnection.user_id)
        .where(
            BankConnection.status != "revoke_pending",
            BankConnection.last_used_at < cutoff,
            User.deleted_at.is_(None),
        )
    ).all()
    for row, user in dormant:
        connection_id, email = row.id, user.email
        try:
            revoke(db, row)
        except (plaid.LinkError, token_vault.VaultError):
            row.status = "revoke_pending"  # hidden now; the next run retries
            db.commit()
            counts["failed"] += 1
            continue
        record(
            db,
            actor_id=user.id,
            action=AuditAction.BANK_AUTO_REVOKED,
            target=f"bank_connection:{connection_id}",
        )
        db.commit()
        send_alert(email, SecurityEvent.BANK_AUTO_REVOKED, device_label="", at=now)
        counts["dormant_revoked"] += 1
    return counts
