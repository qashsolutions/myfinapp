"""Home's next move (docs/spec.md "Next move (Home card)", "Rules added for Home").

Next move      the first rule in the config's order whose condition holds. The config carries
               the order and every threshold, so this module has no numbers of its own.
Set aside      jar deposits logged this month (dated today or earlier) against the month's save
               target, and which paydays of the month had a deposit in their pay period.
Payday nudge   save target × paycheck ÷ monthly take-home, half-even; without a target, a
               configured share of the paycheck.
"""

from __future__ import annotations

from datetime import date

from . import dates, money
from .errors import RuleError
from .money import _int

RULE_IDS = (
    "shortfall",
    "set_pay",
    "payday_set_aside",
    "starter_fund",
    "high_apr",
    "bill_due",
    "grow_runway",
    "goal_behind_pace",
    "start_goal",
)
THRESHOLDS = (
    "starter_fund_cents",
    "high_apr_bps",
    "bill_due_within_days",
    "runway_min_tenths",
    "set_aside_share_bps",
)


def validate_config(config: object) -> dict:
    if not isinstance(config, dict):
        raise RuleError("invalid_config")
    order = config.get("order")
    thresholds = config.get("thresholds")
    if not isinstance(order, list) or not order or len(set(order)) != len(order):
        raise RuleError("invalid_config")
    if any(rule not in RULE_IDS for rule in order) or order[-1] != "start_goal":
        raise RuleError("invalid_config")
    if not isinstance(thresholds, dict) or set(thresholds) != set(THRESHOLDS):
        raise RuleError("invalid_config")
    for value in thresholds.values():
        if _int(value, "invalid_config") < 0:
            raise RuleError("invalid_config")
    return {"order": list(order), "thresholds": dict(thresholds)}


def _optional_int(value: object, code: str = "invalid_integer") -> int | None:
    if value is None:
        return None
    result = _int(value, code)
    if result < 0:
        raise RuleError("invalid_amount")
    return result


def _facts(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_facts")
    out: dict = {}
    shortfall = raw.get("shortfall")
    if shortfall is not None:
        if not isinstance(shortfall, dict):
            raise RuleError("invalid_facts")
        out["shortfall"] = {
            "short_by_cents": _optional_int(shortfall.get("short_by_cents")),
            "date": dates.parse_date(shortfall.get("date")).isoformat(),
        }
    else:
        out["shortfall"] = None
    out["take_home_cents"] = _optional_int(raw.get("take_home_cents"))
    payday = raw.get("payday")
    if payday is not None:
        if not isinstance(payday, dict) or not isinstance(
            payday.get("set_aside_this_period"), bool
        ):
            raise RuleError("invalid_facts")
        out["payday"] = {
            "paycheck_cents": _optional_int(payday.get("paycheck_cents")) or 0,
            "suggested_cents": _optional_int(payday.get("suggested_cents")) or 0,
            "set_aside_this_period": payday["set_aside_this_period"],
        }
    else:
        out["payday"] = None
    out["emergency_saved_cents"] = _optional_int(raw.get("emergency_saved_cents"))
    out["max_apr_bps"] = _optional_int(raw.get("max_apr_bps"))
    bill = raw.get("next_bill")
    if bill is not None:
        if not isinstance(bill, dict) or not isinstance(bill.get("label"), str):
            raise RuleError("invalid_facts")
        out["next_bill"] = {
            "label": bill["label"],
            "date": dates.parse_date(bill.get("date")),
            "amount_cents": _optional_int(bill.get("amount_cents")) or 0,
        }
    else:
        out["next_bill"] = None
    out["runway_tenths"] = _optional_int(raw.get("runway_tenths"))
    behind = raw.get("behind_goal")
    if behind is not None:
        if (
            not isinstance(behind, dict)
            or not isinstance(behind.get("id"), str)
            or not isinstance(behind.get("title"), str)
        ):
            raise RuleError("invalid_facts")
        out["behind_goal"] = {
            "id": behind["id"],
            "title": behind["title"],
            "per_period_cents": _optional_int(behind.get("per_period_cents")) or 0,
            "behind_cents": _optional_int(behind.get("behind_cents")) or 0,
        }
    else:
        out["behind_goal"] = None
    return out


def pick(facts: object, config: object, as_of: str) -> dict:
    """The one card Home shows: {"id", "params"} for the first rule that applies."""
    today = dates.parse_date(as_of)
    cfg = validate_config(config)
    t = cfg["thresholds"]
    f = _facts(facts)
    for rule in cfg["order"]:
        if rule == "shortfall" and f["shortfall"] is not None:
            return {"id": rule, "params": dict(f["shortfall"])}
        if rule == "set_pay" and not f["take_home_cents"]:
            return {"id": rule, "params": {}}
        if (
            rule == "payday_set_aside"
            and f["payday"] is not None
            and not f["payday"]["set_aside_this_period"]
            and f["payday"]["suggested_cents"] > 0
        ):
            return {"id": rule, "params": {"amount_cents": f["payday"]["suggested_cents"]}}
        if (
            rule == "starter_fund"
            and f["emergency_saved_cents"] is not None
            and f["emergency_saved_cents"] < t["starter_fund_cents"]
        ):
            return {
                "id": rule,
                "params": {
                    "target_cents": t["starter_fund_cents"],
                    "remaining_cents": t["starter_fund_cents"] - f["emergency_saved_cents"],
                },
            }
        if (
            rule == "high_apr"
            and f["max_apr_bps"] is not None
            and f["max_apr_bps"] >= t["high_apr_bps"]
        ):
            return {"id": rule, "params": {"apr_bps": f["max_apr_bps"]}}
        if rule == "bill_due" and f["next_bill"] is not None:
            days = dates.days_until(today, f["next_bill"]["date"])
            if 0 <= days <= t["bill_due_within_days"]:
                return {
                    "id": rule,
                    "params": {
                        "label": f["next_bill"]["label"],
                        "date": f["next_bill"]["date"].isoformat(),
                        "amount_cents": f["next_bill"]["amount_cents"],
                        "days": days,
                    },
                }
        if (
            rule == "grow_runway"
            and f["runway_tenths"] is not None
            and f["runway_tenths"] < t["runway_min_tenths"]
        ):
            return {"id": rule, "params": {"runway_tenths": f["runway_tenths"]}}
        if rule == "goal_behind_pace" and f.get("behind_goal") is not None:
            return {"id": rule, "params": dict(f["behind_goal"])}
        if rule == "start_goal":
            return {"id": rule, "params": {}}
    raise RuleError("invalid_config")


def set_aside(deposits: object, as_of: str, target_cents: object, paydays: object) -> dict:
    today = dates.parse_date(as_of)
    start, end = dates.month_bounds(today)
    target = _optional_int(target_cents)
    if not isinstance(deposits, list) or not isinstance(paydays, list):
        raise RuleError("invalid_deposits")
    rows: list[tuple[date, int]] = []
    for raw in deposits:
        if not isinstance(raw, dict):
            raise RuleError("invalid_deposit")
        day = dates.parse_date(raw.get("date"))
        cents = _int(raw.get("amount_cents"))
        if cents < 0:
            raise RuleError("invalid_amount")
        if start <= day <= today:
            rows.append((day, cents))
    total = sum(cents for _, cents in rows)
    days = sorted({dates.parse_date(p) for p in paydays if start <= dates.parse_date(p) <= end})
    out_paydays = []
    for i, payday in enumerate(days):
        if payday > today:
            out_paydays.append({"date": payday.isoformat(), "set_aside": False, "due": False})
            continue
        period_end = days[i + 1] if i + 1 < len(days) else end
        done = any(payday <= day < period_end or (day == period_end == end) for day, _ in rows)
        out_paydays.append({"date": payday.isoformat(), "set_aside": done, "due": True})
    return {
        "set_aside_cents": total,
        "target_cents": target,
        "progress_bps": money.ratio_bps(total, target) if target else None,
        "paydays": out_paydays,
        "paydays_so_far": sum(1 for p in out_paydays if p["due"]),
        "paydays_set_aside": sum(1 for p in out_paydays if p["set_aside"]),
    }


def payday_nudge(
    paycheck_cents: object, target_cents: object, monthly_take_home_cents: object, share_bps: object
) -> int:
    paycheck = _int(paycheck_cents)
    target = _optional_int(target_cents)
    monthly = _int(monthly_take_home_cents)
    share = _int(share_bps)
    if paycheck < 0 or monthly < 0 or share < 0:
        raise RuleError("invalid_amount")
    if target is not None and monthly > 0:
        return money.round_div(target * paycheck, monthly)
    return money.pct_of(paycheck, share)
