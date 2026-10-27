"""Response headers for an API that serves JSON and nothing else.

docs/spec.md "Security": TLS everywhere, HSTS, strict CSP. The PWA's CSP is set where the PWA
is served; this is the API's own defence in depth. Pure ASGI, no per-request allocation
beyond the header list.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DEFAULT_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}
CSP = "default-src 'none'; frame-ancestors 'none'"
HSTS = "max-age=31536000; includeSubDomains"


class SecurityHeaders:
    def __init__(self, app: ASGIApp, *, hsts: bool) -> None:
        self.app = app
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        # The interactive docs page (dev only) loads its own scripts; everything else is JSON.
        csp = not scope.get("path", "").startswith("/docs")

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in DEFAULT_HEADERS.items():
                    headers.setdefault(name, value)
                if csp:
                    headers.setdefault("content-security-policy", CSP)
                if self.hsts:
                    headers.setdefault("strict-transport-security", HSTS)
            await send(message)

        await self.app(scope, receive, send_with_headers)
