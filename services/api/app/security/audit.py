"""audit_log writer.

docs/spec.md "Security program": sign-ins, exports, deletions, plan changes and admin actions;
no amounts or receipt contents in logs. The action set is closed, the target is a short
identifier, and the IP is stored as a keyed pseudonym.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.security.hashing import pseudonym

TARGET_MAX_LENGTH = 120


class AuditAction(StrEnum):
    SIGN_IN = "sign_in"
    SIGN_IN_FAILED = "sign_in_failed"
    SIGN_OUT = "sign_out"
    PASSKEY_ADDED = "passkey_added"
    PASSKEY_REMOVED = "passkey_removed"
    DEVICE_REVOKED = "device_revoked"
    EXPORT = "export"
    DELETE_REQUESTED = "delete_requested"
    DELETE_COMPLETED = "delete_completed"
    EMAIL_CHANGED = "email_changed"
    PLAN_CHANGED = "plan_changed"
    GROUP_CREATED = "group_created"
    GROUP_JOINED = "group_joined"
    GROUP_LEFT = "group_left"
    GROUP_MEMBER_REMOVED = "group_member_removed"
    GROUP_CODE_REGENERATED = "group_code_regenerated"
    BACKUP_ENABLED = "backup_enabled"
    BACKUP_DISABLED = "backup_disabled"
    HOUSEHOLD_INVITED = "household_invited"
    HOUSEHOLD_JOINED = "household_joined"
    HOUSEHOLD_LEFT = "household_left"
    BANK_CONNECTED = "bank_connected"  # Phase 3
    BANK_DISCONNECTED = "bank_disconnected"  # Phase 3
    BANK_AUTO_REVOKED = "bank_auto_revoked"  # chunk 3.4: 60 days without opening the app
    LOCK_CHANGED = "lock_changed"  # the auto-lock window (5 to 60 minutes)
    PURCHASE_CONSENT = "purchase_consent"  # "Before you subscribe" ticked (October 14, 2026)
    DEVICE_LINK_APPROVED = "device_link_approved"  # a phone approved a computer (Oct 19, 2026)
    DEVICE_LINK_DENIED = "device_link_denied"
    # Getting back in without a passkey (October 30, 2026; invariant 74)
    RECOVERY_STARTED = "recovery_started"
    RECOVERY_PARTNER_ASKED = "recovery_partner_asked"
    RECOVERY_APPROVED = "recovery_approved"  # by the partner
    RECOVERY_CANCELLED = "recovery_cancelled"
    RECOVERY_DONE = "recovery_done"
    RECOVERY_PARTNER_SET = "recovery_partner_set"  # "Let my partner help" on or off


def record(
    session: Session,
    *,
    actor_id: uuid.UUID | None,
    action: AuditAction | str,
    target: str | None = None,
    ip: str | None = None,
    at: datetime | None = None,
) -> AuditLog:
    """Add one audit row to the session (flushed, not committed: the caller's transaction owns it).

    `action` must be an AuditAction; `target` is an identifier like "user:<id>", never prose.
    """
    action = AuditAction(action)  # ValueError for anything outside the closed set
    if target is not None and (len(target) > TARGET_MAX_LENGTH or "\n" in target or " " in target):
        raise ValueError("audit target must be a short identifier without spaces or newlines")
    row = AuditLog(
        actor_id=actor_id,
        action=action.value,
        target=target,
        ip_hash=pseudonym(ip) if ip else None,
        at=at or datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    return row
