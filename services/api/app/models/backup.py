"""backup_keys and backups (docs/spec.md "End-to-end encrypted backup").

The device makes the backup key and never sends it. The server keeps only wrapped copies it
cannot open (one under the recovery key, one under the passkey's PRF output where the browser
supports it) and an index of ciphertext blobs in object storage.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, StackdRow


class BackupKey(Base, StackdRow):
    __tablename__ = "backup_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    key_version: Mapped[int]
    recovery_wrapped: Mapped[str] = mapped_column(
        String(512)
    )  # base64url, AES-GCM under the recovery key
    recovery_salt: Mapped[str] = mapped_column(String(128))
    passkey_wrapped: Mapped[str | None] = mapped_column(String(512))  # under the passkey PRF output
    passkey_salt: Mapped[str | None] = mapped_column(String(128))
    passkey_credential_id: Mapped[str | None] = mapped_column(String(512))


class Backup(Base, StackdRow):
    __tablename__ = "backups"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    blob_key: Mapped[str] = mapped_column(String(200), unique=True)
    size: Mapped[int]
    key_version: Mapped[int]
    snapshot_at: Mapped[datetime]
    device_label: Mapped[str] = mapped_column(String(80))
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
