"""The one way a connection's status changes once it exists (invariant 72, October 29, 2026).

`revoke_pending` means we are removing the connection (Disconnect, deletion, dormancy, a link
the person never kept) and Plaid has not confirmed yet. It is terminal: no webhook, sync, card
read or relink moves it back to ok, login_required or revoked, because the row would come back
into the person's list and their `bank_links_max` while `stackd-api revoke-links`, which retries
only `revoke_pending`, would never revoke its token. Only a revoke that succeeds ends it (the
row is deleted, `routers.linking.revoke`).

The write is a conditional UPDATE, not an attribute set, so a sync that read the row before a
Disconnect committed (and then waited on Plaid) can't overwrite the Disconnect either.
"""

from __future__ import annotations

from sqlalchemy import update
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.orm.attributes import set_committed_value

from app.models.linking import BankConnection

BEING_REMOVED = "revoke_pending"


def set_status(db: DbSession, row: BankConnection, status: str) -> bool:
    """Move `row` to `status` unless it is being removed, here or in the database. Returns
    whether it moved. Only the removing paths set `revoke_pending`, directly."""
    if status == BEING_REMOVED:
        raise ValueError("removing paths set revoke_pending themselves")
    if row.status == BEING_REMOVED:
        return False
    result = db.execute(
        update(BankConnection)
        .where(BankConnection.id == row.id, BankConnection.status != BEING_REMOVED)
        .values(status=status)
        .execution_options(synchronize_session=False)
    )
    moved = bool(result.rowcount)
    # Keep the loaded row in step without the ORM writing status again on flush.
    set_committed_value(row, "status", status if moved else BEING_REMOVED)
    return moved
