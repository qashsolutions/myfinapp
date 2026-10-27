"""Groups (docs/spec.md "Groups", "Calculation rules" Group rank).

Group rank   sort by progress %, ties by earliest reach time; members with no events yet are
             hidden. Percentages are the true value (a member can pass 100%); capping the
             display is the app's job. Times are ISO UTC strings ("2026-10-12T09:00:00Z")
             compared as text, so both engines order them identically.
"""

from __future__ import annotations

import re

from .errors import RuleError
from .money import _int

_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


def rank(members: object) -> dict:
    if not isinstance(members, list):
        raise RuleError("invalid_members")
    rows: list[tuple[str, int, str | None, bool, int]] = []
    for i, m in enumerate(members):
        if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not m["id"]:
            raise RuleError("invalid_member")
        if not isinstance(m.get("has_events"), bool):
            raise RuleError("invalid_member")
        progress = _int(m.get("progress_bps"), "invalid_progress")
        if progress < 0:
            raise RuleError("invalid_progress")
        reached = m.get("reached_at")
        if reached is not None and (not isinstance(reached, str) or not _TIME.fullmatch(reached)):
            raise RuleError("invalid_time")
        rows.append((m["id"], progress, reached, m["has_events"], i))
    shown = [r for r in rows if r[3]]
    shown.sort(key=lambda r: (-r[1], r[2] is None, r[2] or "", r[4]))
    return {
        "ranked": [
            {"id": r[0], "rank": n + 1, "progress_bps": r[1], "reached_at": r[2]}
            for n, r in enumerate(shown)
        ],
        "hidden": [r[0] for r in rows if not r[3]],
    }
