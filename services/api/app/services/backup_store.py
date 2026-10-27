"""Ciphertext backups in object storage (docs/spec.md "End-to-end encrypted backup").

The device encrypts before upload; this module moves opaque bytes and keeps the index. The
newest few backups per user are kept so a bad upload cannot wipe the only copy, plus the newest
one from each of the days before (October 24, 2026), so a burst of bad uploads (a stolen,
unlocked session uploads freely) cannot push out every good copy; the device steps back past
any copy it can't open.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models.backup import Backup, BackupKey
from app.storage import get_s3

KEEP_BACKUPS = 3
KEEP_DAILY_DAYS = 7  # the newest backup of each of the 7 days before today (UTC)


def blob_key(user_id: uuid.UUID, backup_id: uuid.UUID) -> str:
    return f"backups/{user_id}/{backup_id}.bin"


def put_blob(key: str, data: bytes) -> None:
    get_s3().put_object(
        Bucket=get_settings().s3_bucket, Key=key, Body=data, ContentType="application/octet-stream"
    )


def get_blob(key: str) -> bytes:
    return get_s3().get_object(Bucket=get_settings().s3_bucket, Key=key)["Body"].read()


def delete_blob(key: str) -> None:
    get_s3().delete_object(Bucket=get_settings().s3_bucket, Key=key)


def list_blob_keys(user_id: uuid.UUID) -> list[str]:
    response = get_s3().list_objects_v2(
        Bucket=get_settings().s3_bucket, Prefix=f"backups/{user_id}/"
    )
    return [obj["Key"] for obj in response.get("Contents", [])]


def store_backup(
    db: DbSession,
    *,
    user_id: uuid.UUID,
    data: bytes,
    key_version: int,
    snapshot_at: datetime,
    device_label: str,
    session_id: uuid.UUID | None,
) -> Backup:
    backup_id = uuid.uuid4()
    key = blob_key(user_id, backup_id)
    put_blob(key, data)
    row = Backup(
        id=backup_id,
        user_id=user_id,
        blob_key=key,
        size=len(data),
        key_version=key_version,
        snapshot_at=snapshot_at,
        device_label=device_label,
        session_id=session_id,
    )
    db.add(row)
    db.flush()
    prune(db, user_id)
    return row


def backups_for(db: DbSession, user_id: uuid.UUID) -> list[Backup]:
    return list(
        db.scalars(
            select(Backup)
            .where(Backup.user_id == user_id)
            .order_by(Backup.created_at.desc(), Backup.id.desc())
        )
    )


def _kept(rows: list[Backup], *, keep: int, days: int, now: datetime) -> set[uuid.UUID]:
    """The newest `keep`, plus the newest of each of the `days` UTC days before today."""
    kept = {row.id for row in rows[:keep]}
    today = now.astimezone(UTC).date()
    first = today - timedelta(days=days)
    seen: set = set()
    for row in rows:  # newest first, so the first row seen for a day is that day's newest
        day = row.created_at.astimezone(UTC).date()
        if first <= day < today and day not in seen:
            seen.add(day)
            kept.add(row.id)
    return kept


def prune(
    db: DbSession,
    user_id: uuid.UUID,
    *,
    keep: int = KEEP_BACKUPS,
    days: int = KEEP_DAILY_DAYS,
    now: datetime | None = None,
) -> int:
    """Drop every backup that is neither one of the newest `keep` nor a day's newest of the
    `days` before today. Returns how many went."""
    rows = backups_for(db, user_id)
    kept = _kept(rows, keep=keep, days=days, now=now or datetime.now(UTC))
    extra = [row for row in rows if row.id not in kept]
    for row in extra:
        delete_blob(row.blob_key)
        db.delete(row)
    db.flush()
    return len(extra)


def delete_all(db: DbSession, user_id: uuid.UUID) -> int:
    """Backup off, or the account deleted: the key record and every blob go."""
    rows = backups_for(db, user_id)
    for row in rows:
        delete_blob(row.blob_key)
        db.delete(row)
    for key in list_blob_keys(user_id):  # anything the index lost track of
        delete_blob(key)
    key_row = db.scalar(select(BackupKey).where(BackupKey.user_id == user_id))
    if key_row is not None:
        db.delete(key_row)
    db.flush()
    return len(rows)
