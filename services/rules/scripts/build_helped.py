"""helped.yaml -> helped.json: the fixed "What helped" choices for the API and the TS port.
Refuses a list with a repeated or badly formed id, an empty label, or a label with a number.

Run: uv run python scripts/build_helped.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
YAML = HERE.parent / "stackd_rules" / "config" / "helped.yaml"
TARGETS = [
    HERE.parent / "stackd_rules" / "config" / "helped.json",
    HERE.parent.parent.parent / "packages" / "rules" / "src" / "helped.json",
]
ID = re.compile(r"[a-z][a-z_]{1,31}")


class CatalogError(ValueError):
    pass


def compile_config(data: dict) -> dict:
    choices = []
    seen: set[str] = set()
    for c in data["choices"]:
        cid, label = str(c["id"]), str(c["label"]).strip()
        if not ID.fullmatch(cid) or cid in seen:
            raise CatalogError(f"bad or repeated id: {cid!r}")
        if not label or re.search(r"[$0-9{}]", label):
            raise CatalogError(f"{cid}: a label is fixed words with no numbers: {label!r}")
        seen.add(cid)
        choices.append({"id": cid, "label": label})
    max_choices, min_answers = int(data["max_choices"]), int(data["min_answers"])
    if not 1 <= max_choices <= len(choices) or min_answers < 2:
        raise CatalogError("max_choices must fit the list and min_answers be at least 2")
    return {
        "version": int(data["version"]),
        "max_choices": max_choices,
        "min_answers": min_answers,
        "choices": choices,
    }


def render() -> str:
    data = yaml.safe_load(YAML.read_text(encoding="utf-8"))
    return json.dumps(compile_config(data), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    text = render()
    for target in TARGETS:
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
