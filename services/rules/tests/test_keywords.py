"""keywords.json copies are current and well-formed.

stackd_rules/config/keywords.yaml is the source; scripts/build_keywords.py writes both copies.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))

from build_keywords import TARGETS, render  # noqa: E402

VALID_CATEGORIES = {
    "cat-rent",
    "cat-groceries",
    "cat-utilities",
    "cat-transport",
    "cat-insurance",
    "cat-dining",
    "cat-shopping",
    "cat-subscriptions",
    "cat-fun",
    "cat-savings",
    "cat-debt-payoff",
    "cat-other",
    "cat-paycheck",
    "cat-side-income",
    "cat-refund",
    "cat-other-income",
}


def test_json_copies_match_the_yaml() -> None:
    expected = render()
    for target in TARGETS:
        assert target.exists(), f"missing {target}; run scripts/build_keywords.py"
        assert target.read_text(encoding="utf-8") == expected, f"{target} is stale"


def test_table_is_well_formed() -> None:
    data = json.loads(render())
    assert data["transfer"] and all(isinstance(w, str) and w for w in data["transfer"])
    for entry in data["keywords"]:
        assert entry["match"] and entry["match"] == entry["match"].strip()
        assert entry["category_id"] in VALID_CATEGORIES, entry
        assert entry["direction"] in {"in", "out", "any"}
        income = entry["category_id"] in {
            "cat-paycheck",
            "cat-side-income",
            "cat-refund",
            "cat-other-income",
        }
        assert entry["direction"] == ("in" if income else "out"), entry
