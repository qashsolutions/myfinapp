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
    "card_trend_months",
    "credit_habits_months",
    "credit_guide_bps",
    "subscription_ask_days",
    "subscription_renewal_days",
    "trial_max_cents",
    "trial_window_days",
}


def test_generated_copies_are_current() -> None:
    for target in build.TARGETS:
        assert target.read_text() == build.render(), f"{target} is stale: run build_insights.py"


def test_every_threshold_is_present() -> None:
    thresholds = build.compile_config()["thresholds"]
    assert set(thresholds) == KEYS
    assert all(isinstance(v, int) and v >= 0 for v in thresholds.values())


def test_month_review_values() -> None:
    review = build.compile_config()["month_review"]
    assert 1 <= review["show_days"] <= 28
    assert review["debt_add_cents"] > 0
    order = review["one_change_order"]
    assert sorted(order) == ["debt_interest", "over_plan", "subscription_check"]
    # the rule accepts the configured order as it stands
    from stackd_rules.registry import RULES

    assert RULES["insights.one_change"](candidates=[], order=order) == {"pick": None}


def test_budget_alert_levels_are_ascending_whole_bps() -> None:
    levels = build.compile_config()["budget_alerts"]["levels_bps"]
    assert levels, "at least one level"
    assert all(isinstance(v, int) and 0 < v <= 100000 for v in levels)
    assert levels == sorted(set(levels))
