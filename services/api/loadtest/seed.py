"""Seed a throwaway database with signed-in accounts for the load test.

Never point this at a real database: it refuses any database not named `stackd_load`.
Each account is what a paying person with the app open looks like to the server: an unlocked
session on one device, a passkey, the Connected plan, a backup key, and a place in a challenge
of five. The session tokens go to loadtest/.output/tokens.txt (gitignored) for locustfile.py.

    STACKD_DATABASE_URL=.../stackd_load uv run python loadtest/seed.py 10000
"""

from __future__ import annotations

import os
import secrets
import sys
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from sqlalchemy import insert, text

from app.db import get_engine, get_session_factory
from app.models.backup import BackupKey
from app.models.billing import Subscription
from app.models.group import Group
from app.models.group_member import GroupMember
from app.models.session import Session
from app.models.user import User
from app.models.webauthn_credential import WebauthnCredential
from app.rules_server.entitlements import store_entitlements
from app.security.hashing import token_hash

OUT = Path(__file__).parent / ".output" / "tokens.txt"
GROUP_SIZE = 5
CHUNK = 1000


def main(count: int) -> None:
    db_name = get_engine().url.database
    if db_name != "stackd_load":
        sys.exit(f"refusing to seed {db_name!r}: only the stackd_load database")
    now = datetime.now(UTC)
    factory = get_session_factory()
    with factory() as s, s.begin():
        s.execute(text("TRUNCATE users, groups RESTART IDENTITY CASCADE"))
    OUT.parent.mkdir(exist_ok=True)
    tokens: list[str] = []
    for start in range(0, count, CHUNK):
        ids = [uuid.uuid4() for _ in range(min(CHUNK, count - start))]
        users, sessions, creds, subs, keys = [], [], [], [], []
        for n, uid in enumerate(ids, start):
            token = secrets.token_urlsafe(32)
            tokens.append(token)
            users.append(
                {
                    "id": uid,
                    "email": f"load{n}@load.test",
                    "display_name": f"Load {n}",
                    "lock_after_minutes": 60,
                }
            )
            sessions.append(
                {
                    "id": uuid.uuid4(),
                    "user_id": uid,
                    "token_hash": token_hash(token),
                    "device_label": "Load test",
                    "last_seen_at": now,
                    "expires_at": now + timedelta(days=30),
                    "passkey_verified_at": now,
                }
            )
            creds.append(
                {
                    "id": uuid.uuid4(),
                    "user_id": uid,
                    "credential_id": secrets.token_bytes(32),
                    "public_key": secrets.token_bytes(77),
                    "device_label": "Load passkey",
                }
            )
            subs.append(
                {
                    "id": uuid.uuid4(),
                    "user_id": uid,
                    "plan": "connected",
                    "source": "stripe",
                    "external_id": f"load_{uid.hex}",
                    "customer_id": f"cus_{uid.hex[:12]}",
                    "status": "active",
                    "interval": "yearly",
                    "renews_at": now + timedelta(days=365),
                }
            )
            keys.append(
                {
                    "id": uuid.uuid4(),
                    "user_id": uid,
                    "key_version": 1,
                    "recovery_wrapped": "A" * 80,
                    "recovery_salt": "B" * 24,
                }
            )
        groups, members = [], []
        for g in range(0, len(ids), GROUP_SIZE):
            gid = uuid.uuid4()
            groups.append(
                {
                    "id": gid,
                    "owner_id": ids[g],
                    "name": "Load challenge",
                    "template_key": "fifty_two_week",
                    "invite_code": f"L{secrets.token_hex(3).upper()}",
                    "start_date": date(2026, 10, 26),
                    "end_date": date(2027, 10, 24),
                }
            )
            members += [
                {"id": uuid.uuid4(), "group_id": gid, "user_id": uid, "joined_at": now}
                for uid in ids[g : g + GROUP_SIZE]
            ]
        with factory() as s, s.begin():
            for model, rows in (
                (User, users),
                (Session, sessions),
                (WebauthnCredential, creds),
                (Subscription, subs),
                (BackupKey, keys),
                (Group, groups),
                (GroupMember, members),
            ):
                s.execute(insert(model), rows)
            for uid in ids:
                store_entitlements(s, uid)
        print(f"seeded {start + len(ids)}", flush=True)
    OUT.write_text("\n".join(tokens) + "\n")
    os.chmod(OUT, 0o600)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1000)
