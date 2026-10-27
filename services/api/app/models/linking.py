"""bank_connections and link_sessions (Phase 3, chunk 3.2; docs/security/linking.md).

A connection holds only what reading it needs: the provider's item id, the access token
encrypted under STACKD_LINK_TOKEN_KEY, and the institution's name for the list and the
security alert. No account numbers, names, balances or transactions: those pass through to
the device. Disconnect revokes the token at the provider and deletes the row.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow

# ok: syncing; login_required: the bank wants the user to sign in again (Plaid update mode);
# revoked: the user or the bank withdrew consent at the provider (set by sync and webhooks);
# revoke_pending: we are removing it (Disconnect, deletion, dormancy) but the provider has not
# confirmed yet; hidden from the user and retried by `stackd-api revoke-links` (chunk 3.4).
CONNECTION_STATUSES = ("ok", "login_required", "revoked", "revoke_pending")
STATUS_SQL = ", ".join(repr(k) for k in CONNECTION_STATUSES)


class BankConnection(Base, StackdRow):
    __tablename__ = "bank_connections"
    __table_args__ = (CheckConstraint(f"status IN ({STATUS_SQL})", name="status"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(20))  # "plaid"
    item_id: Mapped[str] = mapped_column(String(100), unique=True)
    access_token_encrypted: Mapped[str] = mapped_column(Text)
    key_id: Mapped[str] = mapped_column(String(16))  # which STACKD_LINK_TOKEN_KEY sealed it
    institution_name: Mapped[str] = mapped_column(String(120))
    # Plaid's id for the bank (e.g. ins_3): a second link to a bank already connected is
    # refused before it becomes an item. Null on rows linked before migration 0020.
    institution_id: Mapped[str | None] = mapped_column(String(40))
    last_used_at: Mapped[datetime]  # 60 days without opening the app revokes (chunk 3.4)
    status: Mapped[str] = mapped_column(String(20), default="ok", server_default="ok")
    last_synced_at: Mapped[datetime | None]  # the device's last successful pull (chunk 3.3)
    updates_available_at: Mapped[datetime | None]  # webhook sets, sync clears


class LinkSession(Base, StackdRow):
    """One trip to the provider's hosted screen: started, then finished once."""

    __tablename__ = "link_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    link_token_encrypted: Mapped[str] = mapped_column(Text)
    # Set for a "sign in again" trip (Plaid update mode) on an existing connection (chunk 3.4).
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("bank_connections.id", ondelete="CASCADE")
    )
    expires_at: Mapped[datetime]
    finished_at: Mapped[datetime | None]
