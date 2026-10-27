"""Only CloudFront may call the API (docs/ops/aws-hosting.md, step F).

The app's CloudFront distribution adds `X-Origin-Verify: <STACKD_ORIGIN_VERIFY>` to every request
it forwards to the container. With the setting on, any other request gets 403, so the
container's public Lightsail address cannot be used to skip CloudFront (its TLS, headers and
DDoS protection) or to forge the viewer address the API reads the client IP from. The health
checks stay open for the Lightsail load balancer and answer one word per check, nothing more.
"""

from __future__ import annotations

import hmac
import json

from starlette.types import ASGIApp, Receive, Scope, Send

HEADER = b"x-origin-verify"
OPEN_PATHS = frozenset({"/health", "/health/ready"})


class OriginVerify:
    def __init__(self, app: ASGIApp, secret: str | None) -> None:
        self.app = app
        self.secret = secret.encode() if secret else None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.secret is None or scope["type"] != "http" or scope["path"] in OPEN_PATHS:
            await self.app(scope, receive, send)
            return
        given = dict(scope.get("headers") or []).get(HEADER, b"")
        if hmac.compare_digest(given, self.secret):
            await self.app(scope, receive, send)
            return
        body = json.dumps({"detail": "forbidden"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
