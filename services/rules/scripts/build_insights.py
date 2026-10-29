"""insights.yaml -> insights.json, for the Python rules (stdlib json) and the TS port.

Run: uv run python scripts/build_insights.py
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
YAML = HERE.parent / "stackd_rules" / "config" / "insights.yaml"
TARGETS = [
    HERE.parent / "stackd_rules" / "config" / "insights.json",
    HERE.parent.parent.parent / "packages" / "rules" / "src" / "insights.json",
]


def compile_config() -> dict:
    data = yaml.safe_load(YAML.read_text(encoding="utf-8"))
    return {
        "version": int(data["version"]),
        "thresholds": {str(k): int(v) for k, v in data["thresholds"].items()},
        "budget_alerts": {
            "levels_bps": [int(v) for v in data["budget_alerts"]["levels_bps"]],
        },
    }


def render() -> str:
    return json.dumps(compile_config(), indent=2) + "\n"


if __name__ == "__main__":
    text = render()
    for target in TARGETS:
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
