"""Backup housekeeping (a scheduled job): keep only the newest few backups per user and drop
every blob of an account that asked to be deleted."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.backup import Backup
from app.models.user import User
from app.services import backup_store


def purge(db: DbSession) -> dict[str, int]:
    pruned = 0
    wiped = 0
    for user_id in set(db.scalars(select(Backup.user_id).distinct())):
        pruned += backup_store.prune(db, user_id)
    for user in db.scalars(select(User).where(User.deleted_at.is_not(None))):
        wiped += backup_store.delete_all(db, user.id)
    db.commit()
    return {"pruned": pruned, "wiped": wiped}
