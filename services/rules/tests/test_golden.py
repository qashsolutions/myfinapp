"""Run every golden pair: RULES[rule](**input) must equal expected, exactly.

Layout: tests/golden/<rule>/<case>.input.json + <case>.expected.json.
A RuleError is compared as {"error": code}. Outputs are JSON round-tripped so a
non-serializable value (Decimal, date) fails here rather than in the engine.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from stackd_rules.errors import RuleError
from stackd_rules.registry import RULES

GOLDEN = Path(__file__).parent / "golden"
SUFFIX = ".input.json"
CASES = sorted(GOLDEN.glob(f"*/*{SUFFIX}"))


def _case_id(path: Path) -> str:
    return f"{path.parent.name}/{path.name[: -len(SUFFIX)]}"


def run_rule(rule: str, payload: dict) -> dict:
    try:
        result = RULES[rule](**payload)
    except RuleError as exc:
        return {"error": exc.code}
    return json.loads(json.dumps(result))


@pytest.mark.parametrize("input_path", CASES, ids=_case_id)
def test_golden(input_path: Path) -> None:
    rule = input_path.parent.name
    expected_path = input_path.with_name(input_path.name[: -len(SUFFIX)] + ".expected.json")
    assert expected_path.exists(), f"missing {expected_path.name}"
    assert rule in RULES, f"golden directory '{rule}' names no registered rule"
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    assert run_rule(rule, payload) == expected


def test_every_rule_has_a_golden_case() -> None:
    covered = {p.parent.name for p in CASES}
    uncovered = sorted(set(RULES) - covered)
    assert not uncovered, f"rules without golden tests: {uncovered}"


def test_every_golden_directory_is_a_rule() -> None:
    dirs = {p.name for p in GOLDEN.iterdir() if p.is_dir()}
    unknown = sorted(dirs - set(RULES))
    assert not unknown, f"golden directories without a rule: {unknown}"


def test_no_orphan_expected_files() -> None:
    orphans = [
        p
        for p in GOLDEN.glob("*/*.expected.json")
        if not p.with_name(p.name[: -len(".expected.json")] + SUFFIX).exists()
    ]
    assert not orphans, f"expected files without input: {[str(p) for p in orphans]}"
