"""Runtime half of the outbound allowlist (hard constraint 2: no AI, and the backend only
talks to known hosts). The static half is tools/check_network_allowlist.py in CI.

`network_allowlist.txt` next to this module is a copy of tools/network_allowlist.txt so the
Docker image carries it; tests/security/test_outbound.py fails if the two differ.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import httpx2

ALLOWLIST_PATH = Path(__file__).with_name("network_allowlist.txt")
ALWAYS_ALLOWED = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
ALWAYS_ALLOWED_SUFFIXES = (".localhost", ".example", ".invalid", ".test")


class OutboundHostNotAllowed(RuntimeError):
    pass


@lru_cache
def load_allowlist(path: Path = ALLOWLIST_PATH) -> tuple[str, ...]:
    hosts = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip().lower()
        if line:
            hosts.append(line)
    return tuple(hosts)


def host_allowed(host: str) -> bool:
    h = host.lower().strip("[]")
    if h in ALWAYS_ALLOWED or h.endswith(ALWAYS_ALLOWED_SUFFIXES):
        return True
    for entry in load_allowlist():
        if entry.startswith("*."):
            if h == entry[2:] or h.endswith(entry[1:]):
                return True
        elif h == entry:
            return True
    return False


def assert_allowed(url: str | httpx2.URL) -> None:
    host = httpx2.URL(str(url)).host
    if not host_allowed(host):
        raise OutboundHostNotAllowed(f"outbound host not allowlisted: {host}")


def _check(request: httpx2.Request) -> None:
    assert_allowed(request.url)


def outbound_client(**kwargs: object) -> httpx2.Client:
    """An HTTP client that refuses non-allowlisted hosts before any connection is made.

    Every outbound call from this service goes through here (email, Stripe, push).
    """
    hooks: dict = dict(kwargs.pop("event_hooks", None) or {})  # type: ignore[call-overload]
    hooks["request"] = [_check, *hooks.get("request", [])]
    kwargs.setdefault("timeout", 10.0)
    return httpx2.Client(event_hooks=hooks, **kwargs)  # type: ignore[arg-type]
