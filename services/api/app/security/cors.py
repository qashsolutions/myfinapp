"""CORS for the public website only (docs/spec.md 1W, "W.3 Public account deletion").

The static site at `STACKD_SITE_ORIGIN` calls three unauthenticated routes under `/api/public/`:
the two deletion routes and the Founding places-left count (October 14, 2026).
Nothing else is reachable cross-origin: the app's routers keep `same_site_only`, and the site
origin is never added to the WebAuthn origins.
"""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

PUBLIC_PREFIX = "/api/public/"


class PublicCors:
    def __init__(self, app: ASGIApp, *, site_origin: str) -> None:
        self.app = app
        self.site_origin = site_origin.rstrip("/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PUBLIC_PREFIX):
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        origin = request.headers.get("origin")
        allowed = origin == self.site_origin
        if request.method == "OPTIONS":
            headers = {"vary": "Origin"}
            if allowed:
                headers.update(
                    {
                        "access-control-allow-origin": self.site_origin,
                        "access-control-allow-methods": "POST, OPTIONS",
                        "access-control-allow-headers": "content-type",
                        "access-control-max-age": "600",
                    }
                )
            await Response(status_code=204, headers=headers)(scope, receive, send)
            return
        if origin is not None and not allowed:
            await Response(
                status_code=403, content='{"detail":"cross_site"}', media_type="application/json"
            )(scope, receive, send)
            return

        async def send_with_cors(message):  # noqa: ANN001 - ASGI message
            if message["type"] == "http.response.start" and allowed:
                headers = list(message.get("headers", []))
                headers.append((b"access-control-allow-origin", self.site_origin.encode()))
                headers.append((b"vary", b"Origin"))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_cors)
