"""Couples & household (docs/spec.md "Couples & household", "Rules added for couples & household").

Shared jar split   each member's contribution is the sum of their own deposits to the jar; on
                   leaving, each keeps a jar holding only their own contributions. Deposits by a
                   member the caller does not list are an error, so nothing is silently dropped.
Combined In / Out  In = sum of members' In, Out = sum of members' Out, Net = In − Out. Totals
                   only: the rule never sees an entry.
"""

from __future__ import annotations

from .errors import RuleError
from .money import _int


def _member_ids(members: object) -> list[str]:
    if not isinstance(members, list) or not members:
        raise RuleError("invalid_members")
    ids: list[str] = []
    for m in members:
        if not isinstance(m, str) or not m or m in ids:
            raise RuleError("invalid_members")
        ids.append(m)
    return ids


def split_contributions(events: object, members: object) -> dict:
    ids = _member_ids(members)
    if not isinstance(events, list):
        raise RuleError("invalid_events")
    totals = dict.fromkeys(ids, 0)
    for e in events:
        if (
            not isinstance(e, dict)
            or not isinstance(e.get("member_id"), str)
            or not isinstance(e.get("type"), str)
        ):
            raise RuleError("invalid_event")
        if e["member_id"] not in totals:
            raise RuleError("unknown_member")
        if e["type"] != "deposit":
            continue  # balance updates and check-ins never move money into a shared jar
        cents = _int(e.get("amount_cents"), "invalid_amount")
        if cents < 0:
            raise RuleError("invalid_amount")
        totals[e["member_id"]] += cents
    return {
        "contributions": [{"member_id": m, "cents": totals[m]} for m in ids],
        "total_cents": sum(totals.values()),
    }


def combine_totals(summaries: object) -> dict:
    if not isinstance(summaries, list):
        raise RuleError("invalid_summaries")
    seen: set[str] = set()
    in_cents = out_cents = 0
    for s in summaries:
        if not isinstance(s, dict) or not isinstance(s.get("member_id"), str) or not s["member_id"]:
            raise RuleError("invalid_summary")
        if s["member_id"] in seen:
            raise RuleError("duplicate_member")
        seen.add(s["member_id"])
        i = _int(s.get("in_cents"), "invalid_amount")
        o = _int(s.get("out_cents"), "invalid_amount")
        if i < 0 or o < 0:
            raise RuleError("invalid_amount")
        in_cents += i
        out_cents += o
    return {
        "in_cents": in_cents,
        "out_cents": out_cents,
        "net_cents": in_cents - out_cents,
        "members": len(seen),
    }
