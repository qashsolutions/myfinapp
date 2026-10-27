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
from app.models.linking import BankConnection

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
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    kind = (str(payload.get("webhook_type") or ""), str(payload.get("webhook_code") or ""))
    item_id = str(payload.get("item_id") or "")
    row = db.scalar(select(BankConnection).where(BankConnection.item_id == item_id))
    if row is None:
        return Ack(received=True, outcome="unknown_item")
    if kind in UPDATES:
        row.updates_available_at = datetime.now(UTC)
        outcome = "updates_available"
    elif kind in LOGIN_REQUIRED:
        error = payload.get("error") or {}
        login = kind != ("ITEM", "ERROR") or error.get("error_code") == "ITEM_LOGIN_REQUIRED"
        if login:
            row.status = "login_required"
        outcome = "login_required" if login else "ignored"
    elif kind in REVOKED:
        row.status = "revoked"
        outcome = "revoked"
    elif kind == ("ITEM", "LOGIN_REPAIRED"):
        row.status = "ok"
        outcome = "repaired"
    else:
        outcome = "ignored"
    db.commit()
    return Ack(received=True, outcome=outcome)
