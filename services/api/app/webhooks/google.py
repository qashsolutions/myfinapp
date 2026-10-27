"""Google Play Real-time developer notifications (Phase 2, chunk 2.4), via Pub/Sub push.

No session, no CSRF guard. The notification body is never trusted: it only names a purchase
token, which is re-verified against the Play Developer API with our service account before
anything changes, so transport authenticity does not matter. Applied once per Pub/Sub
messageId. A Play API outage answers 502 so Pub/Sub retries later.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.security.audit import AuditAction, record
from app.services import native_billing
from app.services.stripe_billing import BillingError

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


class Ack(BaseModel):
    received: bool
    outcome: str


@router.post("/google")
async def google_webhook(request: Request, db: Annotated[DbSession, Depends(get_db)]) -> Ack:
    try:
        body: Any = await request.json()
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bad_payload") from exc
    if not isinstance(body, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bad_payload")
    try:
        outcome = native_billing.handle_google_rtdn(db, body)
    except BillingError as exc:
        if exc.code == "play_api":
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    if outcome not in ("ignored", "duplicate"):
        record(
            db, actor_id=None, action=AuditAction.PLAN_CHANGED, target=f"google:{outcome}", ip=None
        )
    db.commit()
    return Ack(received=True, outcome=outcome)
