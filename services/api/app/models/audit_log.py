"""audit_log: sign-ins, exports, deletions, plan changes, admin actions.

Five fields, as docs/spec.md lists them: actor_id, action, target, ip_hash, at. There is
deliberately no free-text column, so amounts and receipt contents cannot end up in logs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Index, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class AuditLog(Base, StackdRow):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_actor_id_at", "actor_id", "at"),)

    # No foreign key: the log must outlive the account it describes (deletion is logged too).
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(40))  # closed set: app.security.audit.AuditAction
    target: Mapped[str | None] = mapped_column(String(120))  # short identifier, e.g. "passkey:<id>"
    ip_hash: Mapped[str | None] = mapped_column(String(64))  # app.security.hashing.pseudonym
    at: Mapped[datetime]  # when it happened; created_at is when it was written
