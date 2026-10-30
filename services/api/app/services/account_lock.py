"""One lock per account for sign-in state that must change together (invariant 74).

Getting back in without a passkey, and every passkey check that cancels it, take this lock
before writing anything else, in that order, so a recovery finishing (it deletes passkeys and
ends sessions) and the owner's passkey check (it updates their passkey and session) never wait
on each other's rows. FOR NO KEY UPDATE: inserting a passkey or session that names the account
takes only a key-share lock, which this never blocks.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.user import User


def lock_account(db: DbSession, user_id: uuid.UUID) -> None:
    db.execute(select(User.id).where(User.id == user_id).with_for_update(key_share=True))
