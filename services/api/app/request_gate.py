"""At most `max_in_flight` requests run inside the app at once; the rest wait their turn here.

Found by the load test (October 31, 2026; services/api/loadtest). Routes are sync, so FastAPI
runs each dependency and the route in its threadpool: a request takes a database connection in
`require_unlocked`, gives its thread back, then waits for another to run the route. With
hundreds of requests at once every thread was waiting on the pool and every connection on a
thread, and the API stalled until the pool's 30-second timeout answered 500s. Waiting here holds
no connection and no thread, and the pool (db.get_engine) has two connections for each request
let in (a rate limit opens its own session), so a request let in always gets one.

A request that waits longer than `queue_wait_seconds` is answered 503 `busy` with Retry-After,
before CloudFront's own 30-second origin timeout. Health checks never wait.
"""

from __future__ import annotations

import asyncio
import json

from starlette.types import ASGIApp, Receive, Scope, Send

BUSY = json.dumps({"detail": "busy"}).encode()


class RequestGate:
    def __init__(self, app: ASGIApp, *, limit: int, wait_seconds: float) -> None:
        self.app = app
        self.limit = limit
        self.wait_seconds = wait_seconds
        self._slots: asyncio.Semaphore | None = None  # made on first use, in the server's loop

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path", "").startswith("/health"):
            await self.app(scope, receive, send)
            return
        if self._slots is None:
            self._slots = asyncio.Semaphore(self.limit)
        try:
            await asyncio.wait_for(self._slots.acquire(), self.wait_seconds)
        except TimeoutError:
            await send(
                {
                    "type": "http.response.start",
                    "status": 503,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"retry-after", b"5"),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": BUSY})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            self._slots.release()
