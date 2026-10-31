"""FastAPI application factory. `uvicorn app.main:app` serves it."""

from __future__ import annotations

from fastapi import FastAPI

from app import API_VERSION
from app.config import get_settings
from app.request_gate import RequestGate
from app.routers import (
    account,
    alerts,
    auth,
    backup,
    billing,
    device_link,
    groups,
    health,
    household,
    linking,
    notifications,
    public_account,
    public_plans,
    recovery,
    security,
)
from app.security.cors import PublicCors
from app.security.headers import SecurityHeaders
from app.security.origin_verify import OriginVerify
from app.services.ops_alerts import ReportErrors
from app.webhooks import apple as apple_webhooks
from app.webhooks import google as google_webhooks
from app.webhooks import plaid as plaid_webhooks
from app.webhooks import stripe as stripe_webhooks


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Qash API",
        version=API_VERSION,
        # Interactive docs and the OpenAPI document (source for packages/api-client) are
        # development conveniences; production serves neither.
        docs_url=None if settings.is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_prod else "/openapi.json",
    )
    # Innermost: an error escaping a route emails the admins, then answers 500 as before.
    app.add_middleware(ReportErrors)
    app.add_middleware(SecurityHeaders, hsts=settings.is_prod)
    app.add_middleware(PublicCors, site_origin=settings.site_origin)
    app.add_middleware(  # a turn each before any route touches the database
        RequestGate, limit=settings.max_in_flight, wait_seconds=settings.queue_wait_seconds
    )
    app.add_middleware(  # outermost: refuse anything that did not come through CloudFront
        OriginVerify,
        secret=settings.origin_verify.get_secret_value() if settings.origin_verify else None,
    )
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(device_link.router)
    app.include_router(security.router)
    app.include_router(recovery.router)  # before household: /api/household/recovery
    app.include_router(account.router)
    app.include_router(groups.router)
    app.include_router(notifications.router)
    app.include_router(alerts.router)
    app.include_router(billing.router)
    app.include_router(backup.router)
    app.include_router(household.router)
    app.include_router(linking.router)
    app.include_router(public_account.router)
    app.include_router(public_plans.router)
    app.include_router(stripe_webhooks.router)
    app.include_router(apple_webhooks.router)
    app.include_router(google_webhooks.router)
    app.include_router(plaid_webhooks.router)
    return app


app = create_app()
