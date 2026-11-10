"""The auto-scaler's decisions and what it asks AWS to do (scripts/autoscale_lambda.py)."""

from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, datetime
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "autoscale_lambda", Path(__file__).parents[1] / "scripts" / "autoscale_lambda.py"
)
assert _spec and _spec.loader
autoscale = importlib.util.module_from_spec(_spec)
sys.modules["autoscale_lambda"] = autoscale  # dataclasses look their module up
_spec.loader.exec_module(autoscale)

L = autoscale.Limits()  # 1 to 3 nodes, up above 60%, down below 25%
QUIET_HOUR = [10.0, 11, 12, 9, 8, 10, 11, 12, 13, 14, 10, 12]


def test_busy_for_10_minutes_adds_a_node() -> None:
    assert autoscale.decide(1, [72, 81], [50] * 10 + [72, 81], L).target == 2


def test_one_busy_reading_or_a_dip_changes_nothing() -> None:
    assert autoscale.decide(1, [72], [20] * 11 + [72], L).target == 1
    assert autoscale.decide(1, [72, 55], [50] * 10 + [72, 55], L).target == 1


def test_a_quiet_hour_removes_a_node_but_never_the_last() -> None:
    assert autoscale.decide(3, [10, 12], QUIET_HOUR, L).target == 2
    assert autoscale.decide(1, [10, 12], QUIET_HOUR, L).target == 1


def test_less_than_an_hour_of_readings_never_scales_down() -> None:
    # Lightsail starts a service's CPU history again at each deploy.
    assert autoscale.decide(2, [10, 12], QUIET_HOUR[:5], L).target == 2


def test_busy_at_the_cap_stays_and_says_so() -> None:
    d = autoscale.decide(3, [90, 95], [90] * 12, L)
    assert d.target == 3 and d.at_cap


def test_no_readings_change_nothing() -> None:
    d = autoscale.decide(2, [], [], L)
    assert d.target == 2 and not d.at_cap


class FakeLightsail:
    def __init__(self, state: str, scale: int, cpu: list[float]) -> None:
        self.state, self.scale, self.cpu, self.updates = state, scale, cpu, []

    def get_container_services(self, serviceName: str) -> dict:  # noqa: N803 - boto3's names
        return {"containerServices": [{"state": self.state, "scale": self.scale, "power": "micro"}]}

    def get_container_service_metric_data(self, **kw) -> dict:
        minutes = (kw["endTime"] - kw["startTime"]).total_seconds() / 60
        points = self.cpu[-2:] if minutes <= 10 else self.cpu
        return {"metricData": [{"timestamp": i, "average": c} for i, c in enumerate(points)]}

    def update_container_service(self, serviceName: str, scale: int) -> None:  # noqa: N803
        self.updates.append((serviceName, scale))


class FakeSns:
    def __init__(self) -> None:
        self.sent: list[str] = []

    def publish(self, TopicArn: str, Subject: str, Message: str) -> None:  # noqa: N803
        self.sent.append(Subject)


def _run(ls, sns, minute: int = 30):
    now = datetime(2026, 11, 10, 18, minute, tzinfo=UTC)
    return autoscale.run(ls, sns, service="qash-api", topic="t", limits=L, now=now)


def test_scaling_up_changes_only_qash_api_and_emails() -> None:
    ls, sns = FakeLightsail("RUNNING", 1, [50] * 10 + [72, 81]), FakeSns()
    assert _run(ls, sns)["action"] == "scaled"
    assert ls.updates == [("qash-api", 2)]
    assert sns.sent == ["Qash API (qash-api): 1 -> 2 nodes"]


def test_a_deploy_in_progress_is_left_alone() -> None:
    ls, sns = FakeLightsail("UPDATING", 1, [90] * 12), FakeSns()
    assert _run(ls, sns)["action"] == "skip"
    assert ls.updates == [] and sns.sent == []


def test_at_the_cap_emails_once_an_hour() -> None:
    ls, sns = FakeLightsail("RUNNING", 3, [90] * 12), FakeSns()
    _run(ls, sns, minute=30)
    assert sns.sent == []
    _run(ls, sns, minute=2)
    assert sns.sent == ["Qash API (qash-api): busy at the cap of 3 nodes"]
    assert ls.updates == []
