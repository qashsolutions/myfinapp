"""Two copies of the API never run the same job at the same moment (invariant 82; November 10,
2026). Production scales the container service out to more nodes, and every node carries the
jobs container: without a lock, plan-ending emails, alert pushes and refund settlement would
race each other."""

from __future__ import annotations

import threading
import time

import pytest

from app import cli


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _recorder(name: str, calls: list, hold: float = 0.0):
    def job() -> int:
        began = time.monotonic()
        time.sleep(hold)
        calls.append((name, began, time.monotonic()))
        return 0

    job.__name__ = name
    return job


def test_two_job_loops_at_once_never_run_a_job_at_the_same_moment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list = []
    names = (
        "dispatch_alerts",
        "plan_lifecycle",
        "settle_deletions",
        "purge_deleted",
        "purge_backups",
        "revoke_links",
        "purge_audit",
        "purge_expired",
    )
    for name in names:
        # Each job holds on long enough for the other loop to reach it while it runs.
        monkeypatch.setattr(cli, name, _recorder(name, calls, hold=0.3))
    start = threading.Barrier(2)

    def node() -> None:
        start.wait()
        cli.jobs_loop(rounds=1, sleep=lambda _s: None)

    nodes = [threading.Thread(target=node) for _ in range(2)]
    for t in nodes:
        t.start()
    for t in nodes:
        t.join(30)
    # Every job ran, and no two runs of one job overlapped. A node that skipped a job while the
    # other ran it may run it again afterwards: each job finds nothing left the second time.
    assert {c[0] for c in calls} == set(names)
    for name in names:
        runs = sorted((b, e) for n, b, e in calls if n == name)
        for (_, end), (begin, _) in zip(runs, runs[1:], strict=False):
            assert begin >= end, f"{name} ran twice at once"


def test_a_job_another_node_holds_is_skipped_then_runs_once_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list = []
    job = _recorder("plan_lifecycle", calls)
    with cli.job_lock("plan_lifecycle") as mine:
        assert mine is True
        with cli.job_lock("plan_lifecycle") as theirs:
            assert theirs is False  # held elsewhere: this node skips its turn
    with cli.job_lock("plan_lifecycle") as again:
        assert again is True  # released when the holder finished
        job()
    assert [c[0] for c in calls] == ["plan_lifecycle"]
