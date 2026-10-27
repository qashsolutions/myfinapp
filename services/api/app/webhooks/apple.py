"""App Store Server Notifications V2 (Phase 2, chunk 2.4): one signed payload per change.

No session, no CSRF guard (Apple is not a browser). The signedPayload's certificate chain must
end at the pinned Apple root, so nothing here is trusted on transport alone; each notification
is applied once by its notificationUUID.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
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


class SignedPayloadIn(BaseModel):
    signedPayload: str  # noqa: N815 - Apple's field name


@router.post("/apple")
def apple_webhook(body: SignedPayloadIn, db: Annotated[DbSession, Depends(get_db)]) -> Ack:
    try:
        outcome = native_billing.handle_apple_notification(db, body.signedPayload)
    except BillingError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.code) from exc
    if outcome not in ("ignored", "duplicate"):
        record(
            db, actor_id=None, action=AuditAction.PLAN_CHANGED, target=f"apple:{outcome}", ip=None
        )
    db.commit()
    return Ack(received=True, outcome=outcome)
