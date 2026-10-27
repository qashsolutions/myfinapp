"""plans.yaml is the one place limits and prices live; prices match the design handoff."""

import json
from pathlib import Path

from app.rules_server.entitlements import LIMIT_KEYS, limits_for, load_plans

TOKENS = Path(__file__).resolve().parents[3] / "docs" / "design-handoff" / "tokens.json"


def test_prices_match_the_handoff_tokens() -> None:
    tokens = json.loads(TOKENS.read_text(encoding="utf-8"))["plans"]
    plans = load_plans()["plans"]
    assert plans["private"]["price_cents"] == {
        "monthly": round(tokens["private"]["monthly"] * 100),
        "yearly": round(tokens["private"]["yearly"] * 100),
    }
    assert plans["connected"]["price_cents"] == {
        "monthly": round(tokens["connected"]["monthly"] * 100),
        "yearly": round(tokens["connected"]["yearly"] * 100),
    }
    assert load_plans()["founding"]["one_time_cents"] == tokens["founding_member"]["one_time"] * 100
    assert load_plans()["founding"]["term_years"] == tokens["founding_member"]["term_years"]


def test_limits_follow_the_owner_decision() -> None:
    assert [
        limits_for(p)["goals_active_max"] for p in ("free", "private", "connected", "founding")
    ] == [2, 4, 10, 10]
    assert (
        limits_for("free")["groups_create"] is False
        and limits_for("private")["groups_create"] is True
    )
    assert (
        limits_for("free")["groups_join_max"] == 1
        and limits_for("connected")["groups_join_max"] is None
    )
    assert (
        limits_for("free")["statement_accounts_max"] == 1
        and limits_for("private")["statement_accounts_max"] is None
    )
    assert set(limits_for("free")) == set(LIMIT_KEYS)
