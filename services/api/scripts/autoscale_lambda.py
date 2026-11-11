"""The API's auto-scaler: an AWS Lambda run by EventBridge Scheduler every 5 minutes (since
November 11, 2026; every 4 hours from November 10 until then; docs/ops/aws-hosting.md,
"Scaling").

Lightsail changes a container service's node count without downtime but never on its own. This
reads qash-api's CPU (5-minute averages) and:
- adds a node after 10 minutes above UP_PCT,
- removes one after an hour below DOWN_PCT,
- never goes below MIN_NODES or above MAX_NODES (the owner's spending cap, 3),
- leaves the service alone while a deploy or another change is in progress,
- emails admin@ through the qash-alerts topic on every change, and hourly while busy at the cap.

It runs as the role qash-autoscale-fn: qash-api's state, CPU and node count, and publishing to
qash-alerts; nothing else. GitHub's schedule ran hours late (November 10, 2026), so it lives here.
The file stands alone (boto3 comes with the Lambda runtime); `decide` is tested in
tests/test_autoscale_lambda.py.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass(frozen=True)
class Limits:
    min_nodes: int = 1
    max_nodes: int = 3
    up_pct: float = 60.0
    down_pct: float = 25.0


@dataclass(frozen=True)
class Decision:
    target: int  # the node count to set; equal to the current one for no change
    at_cap: bool  # busy, but already at max_nodes
    why: str


def decide(scale: int, recent: list[float], hour: list[float], limits: Limits) -> Decision:
    """`recent`: the last 10 minutes' 5-minute CPU averages; `hour`: the last hour's."""
    if len(recent) >= 2 and all(c > limits.up_pct for c in recent):
        if scale < limits.max_nodes:
            return Decision(scale + 1, False, f"above {limits.up_pct:g}% for 10 minutes")
        return Decision(scale, True, f"above {limits.up_pct:g}% at the cap")
    if len(hour) >= 11 and all(c < limits.down_pct for c in hour) and scale > limits.min_nodes:
        return Decision(scale - 1, False, f"below {limits.down_pct:g}% for an hour")
    return Decision(scale, False, "no change")


def _limits() -> Limits:
    env = os.environ
    return Limits(
        min_nodes=int(env.get("MIN_NODES", 1)),
        max_nodes=int(env.get("MAX_NODES", 3)),
        up_pct=float(env.get("UP_PCT", 60)),
        down_pct=float(env.get("DOWN_PCT", 25)),
    )


def _cpu(lightsail, service: str, now: datetime, minutes: int) -> list[float]:
    data = lightsail.get_container_service_metric_data(
        serviceName=service,
        metricName="CPUUtilization",
        startTime=now - timedelta(minutes=minutes),
        endTime=now,
        period=300,
        statistics=["Average"],
    )["metricData"]
    return [d["average"] for d in sorted(data, key=lambda d: d["timestamp"])]


def run(lightsail, sns, *, service: str, topic: str, limits: Limits, now: datetime) -> dict:
    found = lightsail.get_container_services(serviceName=service)["containerServices"][0]
    state, scale, power = found["state"], int(found["scale"]), found["power"]
    if state != "RUNNING":
        return {"state": state, "scale": scale, "action": "skip"}
    recent = _cpu(lightsail, service, now, 10)
    hour = _cpu(lightsail, service, now, 60)
    d = decide(scale, recent, hour, limits)
    cpu = f"last 10 min {[round(c) for c in recent]}; last hour {[round(c) for c in hour]}"
    if d.target != scale:
        lightsail.update_container_service(serviceName=service, scale=d.target)
        sns.publish(
            TopicArn=topic,
            Subject=f"Qash API ({service}): {scale} -> {d.target} nodes",
            Message=f"The auto-scaler changed {service} from {scale} to {d.target} node(s) "
            f"({power}): CPU {d.why}. CPU %, 5-minute averages: {cpu}. Cap: {limits.max_nodes}.",
        )
        return {"scale": scale, "target": d.target, "action": "scaled", "why": d.why}
    if d.at_cap and now.minute < 5:  # tell the owner once an hour, not every 5 minutes
        sns.publish(
            TopicArn=topic,
            Subject=f"Qash API ({service}): busy at the cap of {limits.max_nodes} nodes",
            Message=f"{service} has been above {limits.up_pct:g}% CPU for 10 minutes on all "
            f"{limits.max_nodes} nodes ({power}). Raising the cap or the node size is the "
            f"owner's call. {cpu}.",
        )
    return {"scale": scale, "action": "at_cap" if d.at_cap else "none", "cpu": cpu}


def handler(event, context):  # the Lambda entry point
    import boto3

    out = run(
        boto3.client("lightsail"),
        boto3.client("sns"),
        service=os.environ.get("SERVICE", "qash-api"),
        topic=os.environ["TOPIC"],
        limits=_limits(),
        now=datetime.now(UTC),
    )
    print(out)
    return out
