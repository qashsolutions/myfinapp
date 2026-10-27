"""Public plan facts for the website (October 14, 2026): how many Founding places are left.

GET /api/public/plans/founding → {cap, left}. No session; read by qash.solutions/pricing
through `security/cors.py` (the site origin only). Counts, never who bought.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.rules_server.entitlements import founding_left

router = APIRouter(prefix="/api/public/plans", tags=["public"])


class FoundingOut(BaseModel):
    cap: int
    left: int


@router.get("/founding")
def founding(response: Response, db: Annotated[DbSession, Depends(get_db)]) -> FoundingOut:
    cap, left = founding_left(db)
    response.headers["cache-control"] = "public, max-age=60"
    return FoundingOut(cap=cap, left=left)
