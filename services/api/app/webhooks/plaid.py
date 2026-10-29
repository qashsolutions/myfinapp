"""Plaid webhooks (Phase 3, chunk 3.3): signature verified on the raw body, then the only thing
recorded is a flag on the connection. No transaction data arrives here, and none is fetched:
the device pulls on its next open (pass-through, docs/security/linking.md).

No session, no CSRF guard (Plaid is not a browser), nothing in the response but an ack.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.linking import plaid, webhook_verify
from app.linking.status import BEING_REMOVED, set_status
from app.models.linking import BankConnection
from app.webhooks.failures import failed

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])

# Plaid webhook codes → what they mean for the connection.
UPDATES = {("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE")}
LOGIN_REQUIRED = {("ITEM", "ERROR"), ("ITEM", "PENDING_EXPIRATION"), ("ITEM", "PENDING_DISCONNECT")}
REVOKED = {("ITEM", "USER_PERMISSION_REVOKED"), ("ITEM", "USER_ACCOUNT_REVOKED")}


class Ack(BaseModel):
    received: bool
    outcome: str


@router.post("/plaid")
async def plaid_webhook(request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Ack:
    if not plaid.configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="linking_unavailable")
    body = await request.body()
    try:
        payload = webhook_verify.verify(body, request.headers.get("plaid-verification", ""))
    except webhook_verify.WebhookError as exc:
        raise failed("plaid", exc) from exc  # 400: a token we can't check is refused
    try:
        return _apply(db, payload)
    except Exception as exc:  # noqa: BLE001 - answered 500, logged and reported (invariant 60)
        db.rollback()
        raise failed("plaid", exc) from exc


def _apply(db: DbSession, payload: dict) -> Ack:
    kind = (str(payload.get("webhook_type") or ""), str(payload.get("webhook_code") or ""))
    item_id = str(payload.get("item_id") or "")
    row = db.scalar(select(BankConnection).where(BankConnection.item_id == item_id))
    if row is None:
        return Ack(received=True, outcome="unknown_item")
    if row.status == BEING_REMOVED:
        # Invariant 72: we are removing it; only a revoke that succeeds changes that, so the
        # bank's news never brings it back into the list or the plan's count.
        return Ack(received=True, outcome="being_removed")
    if kind in UPDATES:
        row.updates_available_at = datetime.now(UTC)
        outcome = "updates_available"
    elif kind in LOGIN_REQUIRED:
        error = payload.get("error") or {}
        login = kind != ("ITEM", "ERROR") or error.get("error_code") == "ITEM_LOGIN_REQUIRED"
        if login:
            set_status(db, row, "login_required")
        outcome = "login_required" if login else "ignored"
    elif kind in REVOKED:
        set_status(db, row, "revoked")
        outcome = "revoked"
    elif kind == ("ITEM", "LOGIN_REPAIRED"):
        set_status(db, row, "ok")
        outcome = "repaired"
    else:
        outcome = "ignored"
    db.commit()
    return Ack(received=True, outcome=outcome)
