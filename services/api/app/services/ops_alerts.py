"""Errors that need a person (owner decision, October 25, 2026): an unhandled API error, a
scheduled job that failed, a purge that skipped an account. Each emails the admins
(`STACKD_ADMIN_EMAILS`) through the usual sender, at most once per kind and place an hour.

The email says what failed and where, never what it was working on: the exception's type and the
app frame it came from, the route template or job name, and how often since the last email. No
exception message (a database error can quote the values it was given), no request data, no
amounts, emails or ids. The full trace stays in the server log, which keeps 30 days.

Reporting never raises: an alert that can't be sent must not turn one failure into two. The
throttle is per process (the api and jobs containers each keep their own), so a flood is at most
a few emails an hour.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

from app.config import get_settings
from app.services.email import Message, get_sender

log = logging.getLogger("stackd.ops")

EVERY_SECONDS = 3600  # at most one email per kind and place an hour

_lock = threading.Lock()
_last_sent: dict[tuple[str, str], float] = {}
_since: dict[tuple[str, str], int] = {}


@dataclass(frozen=True)
class Report:
    kind: str  # api_error, job_failed, purge_skipped
    where: str  # "POST /api/billing/checkout", "purge_deleted"
    error: str  # the exception's class name
    origin: str  # "app/services/deletion.py:241", the innermost frame inside app/


_APP_DIR = str(Path(__file__).resolve().parents[1])  # the `app` package, wherever it is installed


def _origin(exc: BaseException) -> str:
    """The innermost frame in our own code (never a library's, even when both sit under /app)."""
    frames = [
        f
        for f in traceback.extract_tb(exc.__traceback__)
        if str(Path(f.filename).resolve()).startswith(_APP_DIR + "/")
    ]
    if not frames:
        return "outside the app"
    f = frames[-1]
    return f"app/{str(Path(f.filename).resolve())[len(_APP_DIR) + 1 :]}:{f.lineno}"


def describe(kind: str, where: str, exc: BaseException | None) -> Report:
    if exc is None:  # a failure the code noticed itself, such as Stripe being unreachable
        return Report(kind=kind, where=where, error="none raised", origin="-")
    return Report(kind=kind, where=where, error=type(exc).__name__, origin=_origin(exc))


def report(kind: str, where: str, exc: BaseException | None, *, clock=time.monotonic) -> bool:
    """Email the admins about this failure unless one went for the same kind and place within
    the hour. Returns True when an email went. Never raises."""
    try:
        r = describe(kind, where, exc)
        key = (r.kind, r.where)
        now = clock()
        with _lock:
            _since[key] = _since.get(key, 0) + 1
            last = _last_sent.get(key)
            if last is not None and now - last < EVERY_SECONDS:
                return False
            count, _since[key] = _since[key], 0
            _last_sent[key] = now
        admins = [a.strip() for a in get_settings().admin_emails if a.strip()]
        for admin in admins:
            get_sender().send(_message(admin, r, count))
        return bool(admins)
    except Exception:  # noqa: BLE001 - see the module docstring
        log.exception("could not send an ops alert")
        return False


def _message(to: str, r: Report, count: int) -> Message:
    times = "once" if count == 1 else f"{count} times"
    return Message(
        to=to,
        subject=f"Qash error: {r.kind} in {r.where}",
        text=(
            f"What failed: {r.kind}\n"
            f"Where: {r.where}\n"
            f"Error: {r.error} at {r.origin}\n"
            f"Seen {times} since the last email about it.\n\n"
            "The full trace is in the server log (Lightsail, kept 30 days). This email never "
            "carries request data; at most one goes per kind and place an hour.\n"
        ),
    )


_ID = re.compile(r"/[0-9a-fA-F-]{8,}|/\d+")


def route_of(scope: dict) -> str:
    """The route's template ("/api/linking/{connection_id}/sync"), else the path with ids
    blanked, so no identifier reaches the email."""
    route = scope.get("route")
    path = getattr(route, "path", None) or _ID.sub("/{id}", str(scope.get("path", "")))
    return f"{scope.get('method', '')} {path}".strip()


class ReportErrors:
    """ASGI middleware: an exception that escapes a route is reported, then raised on as before
    (the server still answers 500 and logs the trace)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        except Exception as exc:
            report("api_error", route_of(scope), exc)
            raise


def reset_for_tests() -> None:
    with _lock:
        _last_sent.clear()
        _since.clear()
