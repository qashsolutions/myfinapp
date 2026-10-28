"""Notification settings and push subscriptions (docs/spec.md "Notifications", "Settings spec").

- GET/PUT /api/notifications/settings: one switch per type with its options, quiet hours,
  daily maximum, pause, time zone
- GET /push/key, POST /push, POST /push/unsubscribe, POST /push/test: Web Push subscriptions,
  stored encrypted; the test push proves the channel works with no money data in it
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models.notification import ALERT_TYPES, DIGEST_TYPES, PushSubscription
from app.rules_server.notify import zone
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_unlocked
from app.services import push, push_native
from app.services.alerts import TITLE, ensure_settings, prefs_for, upsert_pref

router = APIRouter(
    prefix="/api/notifications", tags=["notifications"], dependencies=[Depends(same_site_only)]
)

MAX_PAUSE_DAYS = 365  # "Pause until" takes a day up to a year ahead
CLOCK = re.compile(r"^[0-9]{2}:[0-9]{2}$")
DAYS = re.compile(r"^[0-6](,[0-6])*$")


class PrefOut(BaseModel):
    enabled: bool
    time_of_day: str | None = None
    days: str | None = None
    lead_days: int | None = None
    threshold: int | None = None
    channel: Literal["push", "email", "both"] | None = None  # weekly_recap only
    # low balance, milestones, group activity: as it happens or one daily summary at time_of_day
    delivery: Literal["instant", "daily"] | None = None


class PrefPatch(BaseModel):
    enabled: bool | None = None
    time_of_day: str | None = Field(default=None, pattern=r"^[0-9]{2}:[0-9]{2}$")
    days: str | None = Field(default=None, pattern=r"^[0-6](,[0-6])*$")
    lead_days: int | None = Field(default=None, ge=0, le=14)
    threshold: int | None = Field(default=None, ge=1, le=4)
    channel: Literal["push", "email", "both"] | None = None  # weekly_recap only
    delivery: Literal["instant", "daily"] | None = None  # DIGEST_TYPES only


class GlobalOut(BaseModel):
    quiet_start: str
    quiet_end: str
    daily_max: int
    paused_until: datetime | None
    timezone: str


class GlobalPatch(BaseModel):
    quiet_start: str | None = Field(default=None, pattern=r"^[0-9]{2}:[0-9]{2}$")
    quiet_end: str | None = Field(default=None, pattern=r"^[0-9]{2}:[0-9]{2}$")
    daily_max: int | None = Field(default=None, ge=0, le=20)
    paused_until: datetime | None = None
    pause: Literal["none", "day", "week"] | None = None
    timezone: str | None = Field(default=None, max_length=64)


class PushOut(BaseModel):
    available: bool
    subscribed: bool


class SettingsOut(BaseModel):
    prefs: dict[str, PrefOut]
    settings: GlobalOut
    push: PushOut


class SettingsPatch(BaseModel):
    prefs: dict[str, PrefPatch] | None = None
    settings: GlobalPatch | None = None


class PushKeyOut(BaseModel):
    public_key: str | None


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: dict[str, str]
    user_agent: str | None = Field(default=None, max_length=120)


class EndpointIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)


class NativeSubscriptionIn(BaseModel):
    """An APNs or FCM device token from the native shell (chunk 2.3). Never money data."""

    platform: Literal["ios", "android"]
    token: str = Field(min_length=16, max_length=4096, pattern=r"^[A-Za-z0-9:_.\-]+$")
    user_agent: str | None = Field(default=None, max_length=120)


class NativeTokenIn(BaseModel):
    platform: Literal["ios", "android"]
    token: str = Field(min_length=16, max_length=4096)


class PushTestOut(BaseModel):
    delivered: int


def _clock_ok(value: str) -> bool:
    return bool(CLOCK.fullmatch(value)) and int(value[:2]) < 24 and int(value[3:]) < 60


def _out(db: DbSession, caller: Caller) -> SettingsOut:
    s = ensure_settings(db, caller.user.id)
    subscribed = (
        db.scalar(
            select(PushSubscription.id).where(
                PushSubscription.user_id == caller.user.id, PushSubscription.revoked_at.is_(None)
            )
        )
        is not None
    )
    return SettingsOut(
        prefs={k: PrefOut(**v) for k, v in prefs_for(db, caller.user.id).items()},
        settings=GlobalOut(
            quiet_start=s.quiet_start,
            quiet_end=s.quiet_end,
            daily_max=s.daily_max,
            paused_until=s.paused_until,
            timezone=s.timezone,
        ),
        push=PushOut(
            available=push.push_available() or push_native.any_available(),
            subscribed=subscribed,
        ),
    )


@router.get("/settings")
def get_settings_(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SettingsOut:
    out = _out(db, caller)
    db.commit()
    return out


@router.put("/settings")
def update_settings(
    body: SettingsPatch,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SettingsOut:
    s = ensure_settings(db, caller.user.id)
    g = body.settings
    if g is not None:
        for field in ("quiet_start", "quiet_end"):
            value = getattr(g, field)
            if value is not None:
                if not _clock_ok(value):
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_time"
                    )
                setattr(s, field, value)
        if g.daily_max is not None:
            s.daily_max = g.daily_max
        if g.timezone is not None:
            if zone(g.timezone).key != g.timezone and g.timezone != "UTC":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_timezone"
                )
            s.timezone = g.timezone
        if g.pause is not None:
            now = datetime.now(UTC)
            s.paused_until = (
                None if g.pause == "none" else now + timedelta(days=1 if g.pause == "day" else 7)
            )
        elif g.paused_until is not None:
            now = datetime.now(UTC)
            until = g.paused_until
            # A day in the past simply means not paused; more than a year ahead is refused.
            if until.tzinfo is None or until > now + timedelta(days=MAX_PAUSE_DAYS + 1):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_pause")
            s.paused_until = until
    for kind, patch in (body.prefs or {}).items():
        if kind not in ALERT_TYPES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_type")
        if patch.time_of_day is not None and not _clock_ok(patch.time_of_day):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_time")
        if patch.channel is not None and kind != "weekly_recap":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="channel_not_supported"
            )
        if patch.delivery is not None and kind not in DIGEST_TYPES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="delivery_not_supported"
            )
        upsert_pref(db, caller.user.id, kind, patch.model_dump(exclude_none=True))
    out = _out(db, caller)
    db.commit()
    return out


@router.get("/push/key")
def push_key(caller: Annotated[Caller, Depends(require_unlocked)]) -> PushKeyOut:
    return PushKeyOut(public_key=push.public_key())


@router.post("/push", status_code=status.HTTP_201_CREATED)
def subscribe(
    body: SubscriptionIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PushOut:
    if not push.push_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="push_unavailable")
    if (
        not body.endpoint.startswith("https://")
        or "p256dh" not in body.keys
        or "auth" not in body.keys
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid_subscription")
    digest = push.endpoint_hash(body.endpoint)
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == digest))
    payload = {
        "endpoint": body.endpoint,
        "keys": {"p256dh": body.keys["p256dh"], "auth": body.keys["auth"]},
    }
    if row is None:
        row = PushSubscription(
            user_id=caller.user.id,
            platform="web",
            endpoint_hash=digest,
            payload_encrypted=push.encrypt_subscription(payload),
            user_agent=body.user_agent,
        )
        db.add(row)
    else:
        row.user_id = (
            caller.user.id
        )  # the browser profile changed hands: the endpoint follows the signed-in user
        row.payload_encrypted = push.encrypt_subscription(payload)
        row.revoked_at = None
        row.user_agent = body.user_agent
    db.commit()
    return PushOut(available=True, subscribed=True)


@router.post("/push/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe(
    body: EndpointIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    row = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint_hash == push.endpoint_hash(body.endpoint),
            PushSubscription.user_id == caller.user.id,
        )
    )
    if row is not None:
        row.revoked_at = datetime.now(UTC)
    db.commit()


@router.post("/push/native", status_code=status.HTTP_201_CREATED)
def subscribe_native(
    body: NativeSubscriptionIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PushOut:
    """An APNs / FCM device token from the shell: stored encrypted, like a Web Push one."""
    if not push_native.available(body.platform):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="push_unavailable")
    digest = push.endpoint_hash(f"{body.platform}:{body.token}")
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == digest))
    payload = {"platform": body.platform, "token": body.token}
    if row is None:
        row = PushSubscription(
            user_id=caller.user.id,
            platform=body.platform,
            endpoint_hash=digest,
            payload_encrypted=push.encrypt_subscription(payload),
            user_agent=body.user_agent,
        )
        db.add(row)
    else:
        row.user_id = caller.user.id  # the device changed hands: the token follows the user
        row.payload_encrypted = push.encrypt_subscription(payload)
        row.revoked_at = None
        row.user_agent = body.user_agent
    db.commit()
    return PushOut(available=True, subscribed=True)


@router.post("/push/native/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe_native(
    body: NativeTokenIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    row = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint_hash == push.endpoint_hash(f"{body.platform}:{body.token}"),
            PushSubscription.user_id == caller.user.id,
        )
    )
    if row is not None:
        row.revoked_at = datetime.now(UTC)
    db.commit()


@router.post("/push/test")
def push_test(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> PushTestOut:
    """One push saying notifications are on: proves the channel, carries nothing else."""
    delivered = 0
    for sub in db.scalars(
        select(PushSubscription).where(
            PushSubscription.user_id == caller.user.id, PushSubscription.revoked_at.is_(None)
        )
    ):
        status_code = push.deliver(
            push.decrypt_subscription(sub.payload_encrypted),
            {
                "title": TITLE,
                "body": "Notifications are on",
                "tag": "test",
                "url": "/me/notifications",
            },
        )
        if 200 <= status_code < 300:
            delivered += 1
        elif status_code in (404, 410):
            sub.revoked_at = datetime.now(UTC)
    db.commit()
    return PushTestOut(delivered=delivered)
