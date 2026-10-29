"""Net worth (docs/spec.md "Insights", "Calculation rules"; owner decision, October 19, 2026).

assets   Σ asset items        debts   Σ debt items        net   assets − debts (may be negative)
groups   each group's total and item count: assets first, then debts; larger first, then by name
share    debts ÷ assets in basis points, half-even, not capped; no assets → None
change   net − the previous snapshot's net; no previous snapshot → None

Items are the person's own values or their latest balances; nothing here is fetched or advised.
"""

from __future__ import annotations

from datetime import date

from . import dates, money
from .errors import RuleError
from .money import _int

GROUPS = {
    "asset": ("cash", "savings", "investments", "retirement", "property", "vehicle", "other_asset"),
    "debt": ("card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other_debt"),
}


def summary(items: list, previous_net_cents: int | None) -> dict:
    if not isinstance(items, list):
        raise RuleError("invalid_item")
    previous = None if previous_net_cents is None else _int(previous_net_cents)
    seen: set[str] = set()
    totals: dict[tuple[str, str], list[int]] = {}
    sums = {"asset": 0, "debt": 0}
    for raw in items:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise RuleError("invalid_item")
        kind, group = raw.get("kind"), raw.get("group")
        if not isinstance(kind, str) or kind not in GROUPS:
            raise RuleError("invalid_kind")
        if group not in GROUPS[kind]:
            raise RuleError("invalid_group")
        value = _int(raw.get("value_cents"), "invalid_amount")
        if value < 0:
            raise RuleError("invalid_amount")
        if raw["id"] in seen:
            raise RuleError("duplicate_item")
        seen.add(raw["id"])
        sums[kind] += value
        entry = totals.setdefault((kind, group), [0, 0])
        entry[0] += value
        entry[1] += 1
    assets, debts = sums["asset"], sums["debt"]
    net = assets - debts
    order = {"asset": 0, "debt": 1}
    groups = sorted(totals.items(), key=lambda kv: (order[kv[0][0]], -kv[1][0], kv[0][1]))
    return {
        "assets_cents": assets,
        "debts_cents": debts,
        "net_cents": net,
        "debt_share_bps": money.ratio_bps(debts, assets),
        "change_cents": None if previous is None else net - previous,
        "groups": [
            {"kind": kind, "group": group, "total_cents": total, "count": count}
            for (kind, group), (total, count) in groups
        ],
    }


DIRECTIONS = ("in", "out")


def _account(raw: object) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not raw["id"]:
        raise RuleError("invalid_account")
    anchors_raw, entries_raw = raw.get("anchors"), raw.get("entries")
    if not isinstance(anchors_raw, list) or not isinstance(entries_raw, list):
        raise RuleError("invalid_account")
    anchors = []
    for a in anchors_raw:
        if not isinstance(a, dict):
            raise RuleError("invalid_anchor")
        anchors.append((dates.parse_date(a.get("as_of")), _int(a.get("balance_cents"))))
    anchors.sort(key=lambda a: a[0])  # stable: same-day points keep their input order
    entries = []
    for e in entries_raw:
        if not isinstance(e, dict):
            raise RuleError("invalid_entry")
        day = dates.parse_date(e.get("date"))
        cents = _int(e.get("amount_cents"), "invalid_amount")
        if cents < 0:
            raise RuleError("invalid_amount")
        if e.get("direction") not in DIRECTIONS:
            raise RuleError("invalid_direction")
        entries.append((day, cents if e["direction"] == "in" else -cents))
    known_from = None
    if anchors:
        known_from = anchors[0][0]
        if entries:
            known_from = min(known_from, dates.add_days(min(d for d, _ in entries), -1))
    return {"id": raw["id"], "anchors": anchors, "entries": entries, "known_from": known_from}


def _balance_on(account: dict, day: date) -> int:
    before = [a for a in account["anchors"] if a[0] <= day]
    if before:
        as_of, balance = before[-1]
        return balance + sum(c for d, c in account["entries"] if as_of < d <= day)
    as_of, balance = account["anchors"][0]
    return balance - sum(c for d, c in account["entries"] if day < d <= as_of)


def history(dates_asked: list, accounts: list, items: list) -> dict:
    """Assets, debts and net on each date, rebuilt from balance points and entries."""
    if not isinstance(dates_asked, list):
        raise RuleError("invalid_dates")
    days = [dates.parse_date(d) for d in dates_asked]
    if any(b <= a for a, b in zip(days, days[1:], strict=False)):
        raise RuleError("invalid_dates")
    if not isinstance(accounts, list) or not isinstance(items, list):
        raise RuleError("invalid_account")
    parsed = [_account(a) for a in accounts]
    if len({a["id"] for a in parsed}) != len(parsed):
        raise RuleError("duplicate_account")
    fixed = []
    seen: set[str] = set()
    for raw in items:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise RuleError("invalid_item")
        if not isinstance(raw.get("kind"), str) or raw.get("kind") not in GROUPS:
            raise RuleError("invalid_kind")
        value = _int(raw.get("value_cents"), "invalid_amount")
        if value < 0:
            raise RuleError("invalid_amount")
        if raw["id"] in seen:
            raise RuleError("duplicate_item")
        seen.add(raw["id"])
        fixed.append((raw["kind"], value, dates.parse_date(raw.get("since"))))
    points = []
    for day in days:
        assets = debts = 0
        known = 0
        partial = False
        for a in parsed:
            if a["known_from"] is None:
                continue
            if day < a["known_from"]:
                partial = True
                continue
            known += 1
            balance = _balance_on(a, day)
            if balance >= 0:
                assets += balance
            else:
                debts -= balance
        for kind, value, since in fixed:
            if since <= day:
                known += 1
                if kind == "asset":
                    assets += value
                else:
                    debts += value
        points.append(
            {
                "date": day.isoformat(),
                "assets_cents": assets if known else None,
                "debts_cents": debts if known else None,
                "net_cents": assets - debts if known else None,
                "partial": partial,
            }
        )
    nets = [p["net_cents"] for p in points if p["net_cents"] is not None]
    return {"points": points, "change_cents": nets[-1] - nets[0] if len(nets) >= 2 else None}
