"""CPU milliseconds the API process spends per request, endpoint by endpoint.

Sends N requests to one endpoint from 8 threads, each as a different seeded person, and reads
the API process's CPU time before and after (ps). Run against loadtest/start-api.sh:

    uv run --with httpx python loadtest/per_endpoint.py [N]
"""

from __future__ import annotations

import base64
import secrets
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8200"
TOKENS = (Path(__file__).parent / ".output" / "tokens.txt").read_text().split()
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1000


def api_cpu() -> float:
    """CPU seconds so far of the process listening on the load test's port."""
    run = subprocess.run
    pid = run(["lsof", "-nP", "-t", "-iTCP:8200", "-sTCP:LISTEN"], capture_output=True, text=True)
    out = run(["ps", "-o", "time=", "-p", pid.stdout.split()[0]], capture_output=True, text=True)
    *hours, minutes, seconds = out.stdout.strip().split(":")
    return (int(hours[0]) if hours else 0) * 3600 + int(minutes) * 60 + float(seconds)


def schedule() -> dict:
    day = datetime.now(UTC).replace(hour=14, minute=0, second=0, microsecond=0)
    return {
        "items": [
            {
                "due_at": (day + timedelta(days=d)).isoformat(),
                "type": "upcoming_expense",
                "dedupe_key": f"bill:{(day + timedelta(days=d)).date()}:{secrets.token_hex(4)}",
            }
            for d in range(1, 11)
        ]
    }


BLOB = base64.urlsafe_b64encode(secrets.token_bytes(65536)).decode().rstrip("=")
CASES = [
    ("GET", "/api/auth/session", None, False),
    ("GET", "/api/groups", None, False),
    ("GET", "/api/notifications/settings", None, False),
    ("GET", "/api/billing/entitlements", None, False),
    ("GET", "/api/billing", None, False),
    ("GET", "/api/backup", None, True),
    ("GET", "/api/household", None, True),
    ("GET", "/api/groups/{id}", None, False),
    ("PUT", "/api/groups/{id}/progress", lambda: {"progress_bps": 5000}, True),
    ("PUT", "/api/alerts/schedule", schedule, True),
    (
        "PUT",
        "/api/backup/blob",
        lambda: {
            "ciphertext": BLOB,
            "key_version": 1,
            "snapshot_at": datetime.now(UTC).isoformat(),
        },
        True,
    ),
]


def client(i: int) -> tuple[httpx.Client, str]:
    c = httpx.Client(
        base_url=BASE,
        headers={
            "Cookie": f"stackd_session={TOKENS[i]}",
            "X-Forwarded-For": f"10.9.{i // 250}.{i % 250 + 1}",
        },
    )
    gid = c.get("/api/groups").json()[0]["id"]
    return c, gid


def measure(clients: list, method: str, path: str, body, background: bool, n: int) -> str:
    times: list[float] = []
    errors = 0

    def one(k: int) -> None:
        nonlocal errors
        c, gid = clients[k % len(clients)]
        t = time.perf_counter()
        r = c.request(
            method,
            path.replace("{id}", gid),
            json=body() if body else None,
            headers={"X-Qash-Background": "1"} if background else None,
        )
        times.append(time.perf_counter() - t)
        if r.status_code >= 400:
            errors += 1

    before = api_cpu()
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(one, range(n)))
    cpu = (api_cpu() - before) / n * 1000
    times.sort()
    p50 = times[len(times) // 2] * 1000
    return f"{method + ' ' + path:34} {cpu:10.2f} {p50:7.1f} {errors:6}"


def main() -> None:
    clients = [client(i) for i in range(400)]
    print(f"{'endpoint':34} {'cpu ms/req':>10} {'p50 ms':>7} {'errors':>6}")
    for method, path, body, background in CASES:
        n = min(N, 300) if "blob" in path else N  # a backup counts against its hourly limit
        print(measure(clients, method, path, body, background, n))


if __name__ == "__main__":
    main()
