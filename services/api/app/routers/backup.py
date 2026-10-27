"""End-to-end encrypted backup (docs/spec.md "End-to-end encrypted backup", Settings "Backup &
devices"): Private and Connected only.

- GET /api/backup: whether backup is on, the wrapped key record, the latest backup, devices
- PUT /api/backup/key: the device's wrapped key copies (recovery key; passkey PRF when supported)
- PUT /api/backup/blob: one ciphertext snapshot; the newest three are kept
- GET /api/backup/blob/latest: the newest ciphertext, for a restore or a sync
- DELETE /api/backup: backup off; the key record and every blob go
"""

from __future__ import annotations

import base64
import binascii
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.backup import BackupKey
from app.rules_server.entitlements import entitlements, require_feature
from app.security.audit import AuditAction, record
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited
from app.services import backup_store
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(prefix="/api/backup", tags=["backup"], dependencies=[Depends(same_site_only)])

MAX_BLOB_BYTES = 8 * 1024 * 1024
B64 = r"^[A-Za-z0-9_-]+$"


class KeyIn(BaseModel):
    key_version: int = Field(ge=1)
    recovery_wrapped: str = Field(min_length=1, max_length=512, pattern=B64)
    recovery_salt: str = Field(min_length=1, max_length=128, pattern=B64)
    passkey_wrapped: str | None = Field(default=None, max_length=512, pattern=B64)
    passkey_salt: str | None = Field(default=None, max_length=128, pattern=B64)
    passkey_credential_id: str | None = Field(default=None, max_length=512, pattern=B64)


class KeyOut(KeyIn):
    created_at: datetime
    updated_at: datetime


class BackupOut(BaseModel):
    id: str
    created_at: datetime
    size: int
    key_version: int
    snapshot_at: datetime
    device_label: str


class DeviceSync(BaseModel):
    label: str
    last_backup_at: datetime


class BackupStatus(BaseModel):
    enabled: bool
    available: bool  # the plan allows it
    key: KeyOut | None
    latest: BackupOut | None
    devices: list[DeviceSync]


class BackupBlobIn(BaseModel):
    ciphertext: str = Field(min_length=1, max_length=MAX_BLOB_BYTES * 4 // 3 + 8, pattern=B64)
    key_version: int = Field(ge=1)
    snapshot_at: datetime


class BackupBlobOut(BackupOut):
    ciphertext: str


def decode_b64url(text: str, *, max_bytes: int) -> bytes:
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bad_ciphertext") from exc
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bad_ciphertext")
    if len(data) > max_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail="too_large")
    return data


def encode_b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _key_out(row: BackupKey) -> KeyOut:
    return KeyOut(
        key_version=row.key_version,
        recovery_wrapped=row.recovery_wrapped,
        recovery_salt=row.recovery_salt,
        passkey_wrapped=row.passkey_wrapped,
        passkey_salt=row.passkey_salt,
        passkey_credential_id=row.passkey_credential_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _backup_out(row) -> BackupOut:
    return BackupOut(
        id=str(row.id),
        created_at=row.created_at,
        size=row.size,
        key_version=row.key_version,
        snapshot_at=row.snapshot_at,
        device_label=row.device_label,
    )


@router.get("")
def backup_status(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> BackupStatus:
    key = db.scalar(select(BackupKey).where(BackupKey.user_id == caller.user.id))
    rows = backup_store.backups_for(db, caller.user.id)
    devices: dict[str, datetime] = {}
    for row in rows:
        if row.device_label not in devices:
            devices[row.device_label] = row.created_at
    return BackupStatus(
        enabled=key is not None,
        available=bool(entitlements(db, caller.user.id).get("backup")),
        key=_key_out(key) if key else None,
        latest=_backup_out(rows[0]) if rows else None,
        devices=[DeviceSync(label=k, last_backup_at=v) for k, v in devices.items()],
    )


@router.put("/key")
def put_key(
    body: KeyIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> KeyOut:
    require_feature(db, caller.user.id, "backup")
    row = db.scalar(select(BackupKey).where(BackupKey.user_id == caller.user.id))
    created = row is None
    if row is None:
        row = BackupKey(
            user_id=caller.user.id,
            key_version=body.key_version,
            recovery_wrapped="",
            recovery_salt="",
        )
        db.add(row)
    row.key_version = body.key_version
    row.recovery_wrapped = body.recovery_wrapped
    row.recovery_salt = body.recovery_salt
    row.passkey_wrapped = body.passkey_wrapped
    row.passkey_salt = body.passkey_salt
    row.passkey_credential_id = body.passkey_credential_id
    db.flush()
    if created:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.BACKUP_ENABLED,
            target=f"user:{caller.user.id}",
            ip=client_ip(request),
        )
    db.commit()
    db.refresh(row)
    if not created:
        # Replacing the key copies changes who can restore: always told (October 24, 2026).
        send_alert(
            caller.user.email,
            SecurityEvent.BACKUP_KEY_CHANGED,
            device_label=caller.session.device_label,
            at=datetime.now(UTC),
        )
    return _key_out(row)


@router.put("/blob", dependencies=[Depends(rate_limited("backup_upload"))])
def put_blob(
    body: BackupBlobIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> BackupOut:
    require_feature(db, caller.user.id, "backup")
    key = db.scalar(select(BackupKey).where(BackupKey.user_id == caller.user.id))
    if key is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="no_key")
    if key.key_version != body.key_version:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="key_version_mismatch")
    data = decode_b64url(body.ciphertext, max_bytes=MAX_BLOB_BYTES)
    row = backup_store.store_backup(
        db,
        user_id=caller.user.id,
        data=data,
        key_version=body.key_version,
        snapshot_at=body.snapshot_at,
        device_label=caller.session.device_label,
        session_id=caller.session.id,
    )
    db.commit()
    db.refresh(row)
    return _backup_out(row)


@router.get("/blob/latest")
def latest_blob(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
    before: uuid.UUID | None = None,
) -> BackupBlobOut:
    """The newest backup, or with `before` the newest one older than that backup: a device that
    can't open a copy steps back to the one before it (October 24, 2026)."""
    rows = backup_store.backups_for(db, caller.user.id)
    if before is not None:
        ids = [r.id for r in rows]
        rows = rows[ids.index(before) + 1 :] if before in ids else []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_backup")
    row = rows[0]
    data = backup_store.get_blob(row.blob_key)
    return BackupBlobOut(**_backup_out(row).model_dump(), ciphertext=encode_b64url(data))


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def backup_off(
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    had_key = db.scalar(select(BackupKey.id).where(BackupKey.user_id == caller.user.id))
    backup_store.delete_all(db, caller.user.id)
    if had_key is not None:
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.BACKUP_DISABLED,
            target=f"user:{caller.user.id}",
            ip=client_ip(request),
        )
    db.commit()
    if had_key is not None:
        send_alert(
            caller.user.email,
            SecurityEvent.BACKUP_TURNED_OFF,
            device_label=caller.session.device_label,
            at=datetime.now(UTC),
        )
