"""The moments catalog (every in-app message, nudge and push label): both generated copies are
current, every next move has copy, push labels never carry data, and a bad catalog is refused."""

import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "build_moments", ROOT / "scripts" / "build_moments.py"
)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

PUSH_TYPES = {
    "upcoming_expense",
    "shortfall_risk",
    "challenge_checkin",
    "goal_behind_pace",
    "milestone_reached",
    "group_activity",
    "weekly_recap",
    "budget_pace",
}


def catalog() -> dict:
    return yaml.safe_load(build.YAML.read_text(encoding="utf-8"))


def test_generated_copies_are_current() -> None:
    for target in build.TARGETS:
        assert target.read_text() == build.render(), f"{target} is stale: run build_moments.py"


def test_every_push_type_has_a_fixed_label() -> None:
    events = build.compile_catalog(catalog())["events"]
    assert {k for k, e in events.items() if "push" in e} == PUSH_TYPES


def test_every_next_move_has_a_nudge() -> None:
    order = yaml.safe_load((ROOT / "stackd_rules" / "config" / "next_move.yaml").read_text())[
        "order"
    ]
    nudges = build.compile_catalog(catalog())["nudges"]
    assert set(order) - {"shortfall"} == set(nudges)  # the shortfall card has its own screen copy


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"push": "You saved {amount}", "settings": "x"}, "fixed text"),
        ({"push": "You saved $5", "settings": "x"}, "fixed text"),
        ({"toast": ["Hi {name}"]}, "not in vars"),
    ],
)
def test_bad_catalogs_are_refused(patch: dict, message: str) -> None:
    data = catalog()
    data["events"]["jar_deposit"] = {**data["events"]["jar_deposit"], **patch}
    with pytest.raises(build.CatalogError, match=message):
        build.compile_catalog(data)
