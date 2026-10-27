"""keywords.yaml -> keywords.json, for the Python rules (stdlib json) and the TS port.

Run: uv run python scripts/build_keywords.py
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
YAML = HERE.parent / "stackd_rules" / "config" / "keywords.yaml"
TARGETS = [
    HERE.parent / "stackd_rules" / "config" / "keywords.json",
    HERE.parent.parent.parent / "packages" / "rules" / "src" / "keywords.json",
]


def compile_keywords() -> dict:
    data = yaml.safe_load(YAML.read_text(encoding="utf-8"))
    keywords = []
    for entry in data["keywords"]:
        keywords.append(
            {
                "match": entry["match"],
                "category_id": entry["category_id"],
                "direction": entry.get("direction", "any"),
            }
        )
    return {"transfer": list(data["transfer"]), "keywords": keywords}


def render() -> str:
    return json.dumps(compile_keywords(), indent=2) + "\n"


if __name__ == "__main__":
    text = render()
    for target in TARGETS:
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
