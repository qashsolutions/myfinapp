"""Stripe webhooks: signature verified on the raw body, each event applied once.

No session, no CSRF guard (Stripe is not a browser), nothing in the response but an ack.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.security.audit import AuditAction, record
from app.services import stripe_billing

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


class Ack(BaseModel):
    received: bool
    outcome: str


@router.post("/stripe")
async def stripe_webhook(request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Ack:
    secret = get_settings().stripe_webhook_secret
    if secret is None or not secret.get_secret_value().strip():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable")
    payload = await request.body()
    header = request.headers.get("stripe-signature", "")
    try:
        event = stripe_billing.verify_signature(payload, header, secret.get_secret_value())
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    try:
        outcome = stripe_billing.apply_event(db, event)
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    if outcome not in ("ignored", "duplicate"):
        obj = (event.get("data") or {}).get("object") or {}
        user_id = stripe_billing._user_id(  # noqa: SLF001 - same package, deliberate
            obj.get("client_reference_id") or (obj.get("metadata") or {}).get("user_id")
        )
        record(
            db,
            actor_id=user_id,
            action=AuditAction.PLAN_CHANGED,
            target=f"stripe:{outcome}",
            ip=None,
        )
    db.commit()
    return Ack(received=True, outcome=outcome)
