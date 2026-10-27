"""The insight thresholds: both generated copies are current, and every key the rules read is
present and a whole non-negative number."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "build_insights", ROOT / "scripts" / "build_insights.py"
)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

KEYS = {
    "usual_increase_cents",
    "usual_increase_bps",
    "lumpy_month_cents",
    "seasonal_increase_cents",
    "seasonal_increase_bps",
}


def test_generated_copies_are_current() -> None:
    for target in build.TARGETS:
        assert target.read_text() == build.render(), f"{target} is stale: run build_insights.py"


def test_every_threshold_is_present() -> None:
    thresholds = build.compile_config()["thresholds"]
    assert set(thresholds) == KEYS
    assert all(isinstance(v, int) and v >= 0 for v in thresholds.values())
