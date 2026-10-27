"""next_move.yaml -> next_move.json, for the Python rules (stdlib json) and the TS port.

Run: uv run python scripts/build_next_move.py
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
YAML = HERE.parent / "stackd_rules" / "config" / "next_move.yaml"
TARGETS = [
    HERE.parent / "stackd_rules" / "config" / "next_move.json",
    HERE.parent.parent.parent / "packages" / "rules" / "src" / "next_move.json",
]


def compile_config() -> dict:
    data = yaml.safe_load(YAML.read_text(encoding="utf-8"))
    return {
        "version": int(data["version"]),
        "order": [str(rule) for rule in data["order"]],
        "thresholds": {str(k): int(v) for k, v in data["thresholds"].items()},
    }


def render() -> str:
    return json.dumps(compile_config(), indent=2) + "\n"


if __name__ == "__main__":
    text = render()
    for target in TARGETS:
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
