"""One simulated person = one device with Qash open, sending what the app sends.

The mix is the app's own: what it reads on open (AppShell's syncs and the screens' first reads),
then a screen change every 15-45 s, the backup sync every 5 minutes (apps/web BackupSync:
GET /api/backup, then an upload when something changed) and, for the one person in ten with a
household, its check every 2 minutes. Calls the app makes on its own carry X-Qash-Background.
Amounts never travel; the payloads are the same shapes the app sends (a percentage, dates and
keys, base64url ciphertext).
"""

from __future__ import annotations

import base64
import itertools
import os
import random
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from locust import HttpUser, between, task

TOKENS = Path(__file__).parent / ".output" / "tokens.txt"
_tokens = itertools.cycle(TOKENS.read_text().split())
BACKUP_EVERY = 300
HOUSEHOLD_EVERY = 120
# A backup is the device's encrypted snapshot; 64 KB is a few months of entries.
BLOB = base64.urlsafe_b64encode(secrets.token_bytes(int(os.environ.get("LOAD_BLOB_BYTES", 65536))))
BLOB = BLOB.decode().rstrip("=")
BG = {"X-Qash-Background": "1"}


def _schedule() -> dict:
    today = datetime.now(UTC).replace(hour=14, minute=0, second=0, microsecond=0)
    return {
        "items": [
            {
                "due_at": (today + timedelta(days=d)).isoformat(),
                "type": "upcoming_expense",
                "dedupe_key": f"bill:{(today + timedelta(days=d)).date()}:{secrets.token_hex(4)}",
            }
            for d in range(1, 11)
        ]
    }


class Person(HttpUser):
    # LOAD_WAIT="0 0" sends back to back (what one server can do); the default is a person.
    wait_time = between(*(float(x) for x in os.environ.get("LOAD_WAIT", "15 45").split()))

    def on_start(self) -> None:
        token = next(_tokens)
        n = random.randint(1, 250)
        self.client.headers.update(
            {
                "Cookie": f"stackd_session={token}",
                "X-Forwarded-For": f"10.{n}.{random.randint(0, 255)}.{random.randint(1, 254)}",
            }
        )
        self.has_household = random.random() < 0.1
        self.group_id = None
        # Opening the app.
        self.client.get("/api/auth/session")
        self.client.get("/api/billing/entitlements")
        self.client.get("/api/billing")
        self.client.get("/api/notifications/settings")
        groups = self.client.get("/api/groups")
        if groups.ok and groups.json():
            self.group_id = groups.json()[0]["id"]
        self.client.get("/api/backup", headers=BG)
        if self.has_household:
            self.client.get("/api/household", headers=BG)
        self.client.put("/api/alerts/schedule", json=_schedule(), headers=BG)
        # Spread the timers, as people open the app at different moments.
        now = time.monotonic()
        self.next_backup = now + random.uniform(0, BACKUP_EVERY)
        self.next_household = now + random.uniform(0, HOUSEHOLD_EVERY)

    def _timers(self) -> None:
        now = time.monotonic()
        if now >= self.next_backup:
            self.next_backup = now + BACKUP_EVERY
            self.client.get("/api/backup", headers=BG)
            if random.random() < 0.5:  # pushes only when the snapshot changed
                self.client.put(
                    "/api/backup/blob",
                    headers=BG,
                    name="/api/backup/blob",
                    json={
                        "ciphertext": BLOB,
                        "key_version": 1,
                        "snapshot_at": datetime.now(UTC).isoformat(),
                    },
                )
        if self.has_household and now >= self.next_household:
            self.next_household = now + HOUSEHOLD_EVERY
            self.client.get("/api/household", headers=BG)

    @task(35)
    def goals_tab(self) -> None:
        self._timers()
        self.client.get("/api/groups")

    @task(20)
    def me_alerts(self) -> None:
        self._timers()
        self.client.get("/api/notifications/settings")

    @task(15)
    def back_to_app(self) -> None:
        self._timers()
        self.client.get("/api/auth/session")

    @task(10)
    def plan_screen(self) -> None:
        self._timers()
        self.client.get("/api/billing")

    @task(10)
    def entitlements(self) -> None:
        self._timers()
        self.client.get("/api/billing/entitlements")

    @task(6)
    def challenge(self) -> None:
        self._timers()
        if self.group_id:
            self.client.get(f"/api/groups/{self.group_id}", name="/api/groups/{id}")
            if random.random() < 0.3:
                self.client.put(
                    f"/api/groups/{self.group_id}/progress",
                    name="/api/groups/{id}/progress",
                    json={"progress_bps": random.randint(0, 10000)},
                    headers=BG,
                )

    @task(4)
    def schedule_changed(self) -> None:
        self._timers()
        self.client.put("/api/alerts/schedule", json=_schedule(), headers=BG)
