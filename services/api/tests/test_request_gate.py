"""The request gate (app/request_gate.py; load test, October 31, 2026): a fixed number of
requests inside the app, the rest wait their turn, a wait past the limit is 503 `busy`, and
health checks never wait."""

from __future__ import annotations

import asyncio
import json

from app.request_gate import RequestGate


def http(path: str = "/api/groups") -> dict:
    return {"type": "http", "path": path, "method": "GET", "headers": []}


async def call(gate: RequestGate, scope: dict) -> int:
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b""}

    async def send(message: dict) -> None:
        sent.append(message)

    await gate(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    if start["status"] == 503:
        body = next(m for m in sent if m["type"] == "http.response.body")["body"]
        assert json.loads(body) == {"detail": "busy"}
        assert (b"retry-after", b"5") in start["headers"]
    return start["status"]


def test_requests_past_the_limit_wait_their_turn_and_a_long_wait_is_busy() -> None:
    inside = 0
    most = 0
    release = asyncio.Event()

    async def app(scope, receive, send) -> None:
        nonlocal inside, most
        inside += 1
        most = max(most, inside)
        if scope["path"] == "/slow":
            await release.wait()
        await asyncio.sleep(0.01)
        inside -= 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def scenario() -> None:
        gate = RequestGate(app, limit=2, wait_seconds=0.2)
        # Six at once through two places: all answered, never more than two inside.
        assert await asyncio.gather(*(call(gate, http()) for _ in range(6))) == [200] * 6
        assert most == 2
        # Both places held: the next waits, then is told busy; a health check walks past.
        slow = [asyncio.create_task(call(gate, http("/slow"))) for _ in range(2)]
        await asyncio.sleep(0.05)
        assert await call(gate, http()) == 503
        assert await call(gate, http("/health/ready")) == 200
        release.set()
        assert await asyncio.gather(*slow) == [200, 200]
        assert await call(gate, http()) == 200  # the places came back

    asyncio.run(scenario())
