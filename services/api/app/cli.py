"""`stackd-api`: operational commands. Installed by pyproject [project.scripts]."""

from __future__ import annotations

import argparse
import sys

from alembic import command

from app.db import alembic_config, database_is_newer, get_engine, migration_status
from app.storage import ensure_bucket


def migrate(check_only: bool) -> int:
    with get_engine().connect() as conn:
        current, head = migration_status(conn)
    if database_is_newer(current):
        # A newer build migrated this database; never fail to start because of it.
        print(f"database at {current}, newer than this build (head {head}); not migrating")
        return 0
    if check_only:
        print(f"database at {current}, head is {head}")
        return 0 if current == head and head is not None else 1
    command.upgrade(alembic_config(), "head")
    with get_engine().connect() as conn:
        current, head = migration_status(conn)
    print(f"migrated: database at {current} (head {head})")
    return 0


def openapi(path: str | None, check: bool) -> int:
    """Write the OpenAPI document (the source for packages/api-client) or verify it is current."""
    import json
    import os

    # The document does not depend on settings; let this run without a configured environment.
    for name, value in {
        "STACKD_DATABASE_URL": "postgresql+psycopg://x:x@localhost/x",
        "STACKD_S3_ENDPOINT_URL": "http://localhost:9000",
        "STACKD_S3_ACCESS_KEY": "x",
        "STACKD_S3_SECRET_KEY": "x",
        "STACKD_IP_HASH_KEY": "x",
        "STACKD_SECRET_KEY": "x",
    }.items():
        os.environ.setdefault(name, value)

    from app.main import create_app

    document = json.dumps(create_app().openapi(), indent=2, sort_keys=True) + "\n"
    if path is None:
        sys.stdout.write(document)
        return 0
    from pathlib import Path

    target = Path(path)
    if check:
        current = target.read_text() if target.exists() else ""
        if current != document:
            print(f"{path} is out of date: run `stackd-api openapi -o {path}`")
            return 1
        print(f"{path} is current")
        return 0
    target.write_text(document)
    print(f"wrote {path}")
    return 0


def purge_deleted() -> int:
    """Hard-delete accounts whose grace period is over (a scheduled job in production)."""
    from app.config import get_settings
    from app.db import get_session_factory
    from app.services.deletion import purge_due

    with get_session_factory()() as session, session.begin():
        count = purge_due(session, grace_days=get_settings().deletion_grace_days)
    print(f"purged {count} account(s)")
    return 0


def dispatch_alerts() -> int:
    """Send due alerts (a scheduled job in production, every few minutes)."""
    from app.db import get_session_factory
    from app.jobs.alert_dispatch import dispatch_due
    from app.jobs.weekly_recap import enqueue_due

    with get_session_factory()() as session:
        recaps = enqueue_due(session)  # the weekly recap by email is scheduled server-side
        counts = dispatch_due(session)
    print(f"recaps_scheduled={recaps} " + " ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


def purge_backups() -> int:
    """Keep the newest backups per user and wipe deleted accounts' blobs (a scheduled job)."""
    from app.db import get_session_factory
    from app.jobs.backup_purge import purge

    with get_session_factory()() as session:
        counts = purge(session)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


def revoke_links() -> int:
    """Retry pending revokes and revoke dormant bank connections (a scheduled job, daily)."""
    from app.db import get_session_factory
    from app.jobs.link_revoke import revoke_due

    with get_session_factory()() as session:
        counts = revoke_due(session)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


def purge_audit() -> int:
    """Delete audit-log rows older than 13 months (a scheduled job, daily)."""
    from app.db import get_session_factory
    from app.jobs.audit_purge import purge

    with get_session_factory()() as session:
        counts = purge(session)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


def plan_lifecycle() -> int:
    """Trial and plan-end emails, and deleting accounts 7 days after a plan ends (hourly)."""
    from app.db import get_session_factory
    from app.jobs.plan_lifecycle import run

    with get_session_factory()() as session:
        counts = run(session)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


def settle_deletions() -> int:
    """End and refund plans Stripe still holds for deleted accounts (hourly; it was unreachable
    when they were deleted, October 25, 2026)."""
    from app.db import get_session_factory
    from app.services.deletion import settle_billing

    with get_session_factory()() as session, session.begin():
        count = settle_billing(session)
    print(f"settled {count} account(s)")
    return 0


def purge_expired() -> int:
    """Delete short-lived records past their use: codes, challenges, counters, link sessions,
    invites, old payment-event ids (a scheduled job, daily)."""
    from app.db import get_session_factory
    from app.jobs.expired_purge import purge

    with get_session_factory()() as session:
        counts = purge(session)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


DISPATCH_EVERY_SECONDS = 60
DAILY_EVERY_SECONDS = 24 * 60 * 60
HOURLY_SECONDS = 60 * 60
DAILY_RETRY_SECONDS = 10 * 60  # a failed daily job (e.g. tables not migrated yet) tries again soon


def jobs_loop(rounds: int | None = None, sleep=None, clock=None) -> int:
    """The production `jobs` container (docs/ops/aws-hosting.md, step F): due alerts every
    minute; each daily job at start-up and then every 24 hours, or 10 minutes after it failed
    (the first run can start before the api container has migrated). One job failing is
    printed and never stops the loop. `rounds`, `sleep` and `clock` are for tests."""
    import time
    import traceback

    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    daily = (purge_deleted, purge_backups, revoke_links, purge_audit, purge_expired)
    hourly = (plan_lifecycle, settle_deletions)
    due_at: dict[str, float] = {}
    done = 0
    while rounds is None or done < rounds:
        started = clock()
        jobs = [dispatch_alerts] + [
            j for j in (*hourly, *daily) if due_at.get(j.__name__, 0.0) <= started
        ]
        for job in jobs:
            ok = True
            try:
                job()
            except Exception as exc:  # noqa: BLE001 - keep the loop alive; the log has the trace
                ok = False
                print(f"job {job.__name__} failed", flush=True)
                traceback.print_exc()
                from app.services.ops_alerts import report  # noqa: PLC0415 - light imports

                report("job_failed", job.__name__, exc)
            if job in daily:
                due_at[job.__name__] = started + (
                    DAILY_EVERY_SECONDS if ok else DAILY_RETRY_SECONDS
                )
            elif job in hourly:
                due_at[job.__name__] = started + (HOURLY_SECONDS if ok else DAILY_RETRY_SECONDS)
        sys.stdout.flush()
        done += 1
        if rounds is None or done < rounds:
            sleep(max(0.0, DISPATCH_EVERY_SECONDS - (clock() - started)))
    return 0


def init_storage() -> int:
    created = ensure_bucket()
    print("bucket created" if created else "bucket already present")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stackd-api")
    sub = parser.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("migrate", help="apply migrations up to head")
    m.add_argument(
        "--check", action="store_true", help="only report; exit 1 if the database is not at head"
    )
    sub.add_parser("init-storage", help="create the backup bucket if missing (dev and test only)")
    sub.add_parser("purge-deleted", help="hard-delete accounts past the deletion grace period")
    sub.add_parser(
        "dispatch-alerts",
        help="schedule recap emails, then send due alerts (quiet hours, daily max, dedupe)",
    )
    sub.add_parser("purge-backups", help="keep the newest backups per user; wipe deleted accounts'")
    sub.add_parser(
        "revoke-links", help="retry pending bank revokes; revoke connections unused for 60 days"
    )
    sub.add_parser("purge-audit", help="delete audit-log rows older than 13 months")
    sub.add_parser("purge-expired", help="delete expired codes, challenges, counters, invites")
    sub.add_parser("plan-lifecycle", help="trial and plan-end emails; delete 7 days after an end")
    sub.add_parser("settle-deletions", help="end and refund plans Stripe kept for deleted accounts")
    sub.add_parser("jobs-loop", help="run every scheduled job forever (the jobs container)")
    o = sub.add_parser("openapi", help="print the OpenAPI document, or write/check a file")
    o.add_argument("-o", "--output", default=None)
    o.add_argument("--check", action="store_true", help="exit 1 if the file is out of date")
    args = parser.parse_args(argv)
    if args.cmd == "openapi":
        return openapi(args.output, args.check)
    if args.cmd == "migrate":
        return migrate(args.check)
    if args.cmd == "init-storage":
        return init_storage()
    if args.cmd == "purge-deleted":
        return purge_deleted()
    if args.cmd == "dispatch-alerts":
        return dispatch_alerts()
    if args.cmd == "purge-backups":
        return purge_backups()
    if args.cmd == "revoke-links":
        return revoke_links()
    if args.cmd == "purge-audit":
        return purge_audit()
    if args.cmd == "purge-expired":
        return purge_expired()
    if args.cmd == "plan-lifecycle":
        return plan_lifecycle()
    if args.cmd == "settle-deletions":
        return settle_deletions()
    if args.cmd == "jobs-loop":
        return jobs_loop()
    return 2


if __name__ == "__main__":
    sys.exit(main())
