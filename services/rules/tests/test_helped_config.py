"""The "What helped" choices: both generated copies are current, the list is the eight fixed
choices, and a bad list is refused (so no free text or numbers ever reach a label)."""

import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_helped", ROOT / "scripts" / "build_helped.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def data() -> dict:
    return yaml.safe_load(build.YAML.read_text(encoding="utf-8"))


def test_generated_copies_are_current() -> None:
    for target in build.TARGETS:
        assert target.read_text() == build.render(), f"{target} is stale: run build_helped.py"


def test_the_fixed_choices() -> None:
    out = build.compile_config(data())
    assert [c["id"] for c in out["choices"]] == [
        "packed_lunch",
        "cooked_home",
        "no_spend_days",
        "cut_subscription",
        "payday_set_aside",
        "waited_a_day",
        "cash_for_treats",
        "shopping_list",
    ]
    assert out["max_choices"] == 5
    assert out["min_answers"] == 2


@pytest.mark.parametrize(
    "patch",
    [
        {"choices": [{"id": "a_b", "label": "x"}, {"id": "a_b", "label": "y"}]},
        {"choices": [{"id": "saved", "label": "Saved $50"}]},
        {"choices": [{"id": "Bad Id", "label": "x"}]},
        {"min_answers": 1},
    ],
)
def test_bad_lists_are_refused(patch: dict) -> None:
    with pytest.raises(build.CatalogError):
        build.compile_config({**data(), **patch})
