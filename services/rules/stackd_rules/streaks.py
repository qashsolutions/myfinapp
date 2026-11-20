"""Streaks, Your path and milestones (owner decision, November 19, 2026; docs/spec.md "Streaks,
Your path and milestones" and the Calculation rules rows of the same names; invariant 94).

weekly        one weekly streak: each week Monday to Sunday is kept, rest, paused, skipped,
              open or missed; the current run, the best, and the last few weeks as a strip.
under_plan    which whole weeks were at or under the month's needs + wants plan so far.
sorted        which whole weeks had every counted entry sorted.
on_time       card payments on time in a row, from Credit habits' due dates.
path          the seven steps of Your path, reached once and kept, in the person's order.
milestones    one-time milestones, reached once and kept.

Thresholds come in from config/insights.yaml (`streaks`, `path`, `milestones`), so the rules
stay pure. Nothing here reads the clock: every rule takes as_of.
"""

from __future__ import annotations

from datetime import date

from .dates import add_days, add_months, days_in_month, parse_date
from .errors import RuleError
from .money import _int, round_div

STATES = ("kept", "rest", "paused", "skipped", "open", "missed", "before")
STEPS = ("setup", "cushion", "starter", "paid_in_full", "debts", "three_months", "later")


def _monday(d: date) -> date:
    return add_days(d, -d.weekday())


def _quarter(d: date) -> tuple[int, int]:
    return (d.year, (d.month - 1) // 3)


def _quarter_start_after(d: date) -> date:
    first = date(d.year, ((d.month - 1) // 3) * 3 + 1, 1)
    return add_months(first, 3)


def _dates(raw: object, code: str) -> list[date]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError(code)
    return [parse_date(v) for v in raw]


def _pauses(raw: object) -> list[tuple[date, date | None]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError("invalid_pauses")
    out = []
    for p in raw:
        if not isinstance(p, dict):
            raise RuleError("invalid_pauses")
        start = parse_date(p.get("start"))
        end = parse_date(p["end"]) if p.get("end") is not None else None
        if end is not None and end < start:
            raise RuleError("invalid_pauses")
        out.append((start, end))
    return out


def _since(since: object, today: date) -> date | None:
    if since is None:
        return None
    first = parse_date(since)
    if first > today:
        raise RuleError("invalid_date")
    return first


def weekly(
    as_of: str,
    since: object,
    met: object,
    rest_quota: object,
    shown: object,
    rests: object = None,
    pauses: object = None,
    skips: object = None,
) -> dict:
    today = parse_date(as_of)
    first = _since(since, today)
    quota = _int(rest_quota, "invalid_amount")
    count = _int(shown, "invalid_amount")
    if quota < 0 or not 1 <= count <= 52:
        raise RuleError("invalid_amount")
    met_weeks = {_monday(d) for d in _dates(met, "invalid_dates") if d <= today}
    skip_weeks = {_monday(d) for d in _dates(skips, "invalid_dates")}
    rest_weeks = sorted({_monday(d) for d in _dates(rests, "invalid_dates")})
    paused = _pauses(pauses)
    this_week = _monday(today)

    def overlaps_pause(start: date) -> bool:
        end = add_days(start, 6)
        return any(ps <= end and (pe is None or pe >= start) for ps, pe in paused)

    def base_state(start: date) -> str:
        if first is None or start < _monday(first):
            return "before"
        if start in met_weeks:
            return "kept"
        if overlaps_pause(start):
            return "paused"
        if start == this_week:
            return "open"
        if start in skip_weeks:
            return "skipped"
        return "missed"

    # Rests apply only to a complete week that would otherwise be missed, the first `quota`
    # in each calendar quarter of the week's Monday.
    applied: set[date] = set()
    used: dict[tuple[int, int], int] = {}
    for week in rest_weeks:
        if week >= this_week or base_state(week) != "missed":
            continue
        q = _quarter(week)
        if used.get(q, 0) >= quota:
            continue
        used[q] = used.get(q, 0) + 1
        applied.add(week)

    def state(start: date) -> str:
        s = base_state(start)
        if s != "missed":
            return s
        return "rest" if start in applied else "missed"

    run = best = kept = 0
    held = 0
    prev_run = 0
    if first is not None:
        week = _monday(first)
        while week < this_week:
            s = state(week)
            prev_run = run
            if s == "kept":
                run += 1
                kept += 1
            elif s == "missed":
                run = 0
            best = max(best, run)
            week = add_days(week, 7)
    now_state = state(this_week)
    current = run + (1 if now_state == "kept" else 0)
    if now_state == "kept":
        kept += 1
    best = max(best, current)
    last = add_days(this_week, -7)
    last_state = None if first is None or last < _monday(first) else state(last)
    if last_state == "missed":
        held = prev_run
    can_rest = last_state == "missed" and used.get(_quarter(last), 0) < quota
    weeks = []
    for k in range(count - 1, -1, -1):
        start = add_days(this_week, -7 * k)
        weeks.append({"start": start.isoformat(), "state": state(start)})
    return {
        "current": current,
        "best": best,
        "kept_weeks": kept,
        "this_week": now_state,
        "last_week": last_state,
        "held": held,
        "can_rest": can_rest,
        "rest_left": max(0, quota - used.get(_quarter(today), 0)),
        "rests_renew": _quarter_start_after(today).isoformat(),
        "weeks": weeks,
    }


def _complete_weeks(first: date | None, today: date):
    if first is None:
        return
    week = _monday(first)
    while add_days(week, 6) < today:
        yield week
        week = add_days(week, 7)


def _entries(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_entries")
    out = []
    for e in raw:
        if not isinstance(e, dict):
            raise RuleError("invalid_entries")
        out.append(e)
    return out


def under_plan(as_of: str, since: object, plans: object, entries: object) -> dict:
    today = parse_date(as_of)
    first = _since(since, today)
    if not isinstance(plans, list):
        raise RuleError("invalid_plans")
    by_month: dict[str, int] = {}
    for p in plans:
        if not isinstance(p, dict):
            raise RuleError("invalid_plans")
        month = p.get("month")
        if not isinstance(month, str) or month in by_month:
            raise RuleError("invalid_plans")
        parse_date(f"{month}-01")
        by_month[month] = _int(p.get("planned_cents"), "invalid_amount")
    rows = []
    for e in _entries(entries):
        direction = e.get("direction")
        if direction not in ("in", "out"):
            raise RuleError("invalid_direction")
        cents = _int(e.get("amount_cents"), "invalid_amount")
        rows.append((parse_date(e.get("date")), cents if direction == "out" else -cents))
    met, skips = [], []
    for week in _complete_weeks(first, today):
        end = add_days(week, 6)
        plan = by_month.get(end.isoformat()[:7])
        if plan is None or plan <= 0:
            skips.append(week.isoformat())
            continue
        start = end.replace(day=1)
        spent = sum(c for d, c in rows if start <= d <= end)
        allowed = round_div(plan * end.day, days_in_month(end))
        if spent <= allowed:
            met.append(week.isoformat())
    return {"met": met, "skips": skips}


def sorted_weeks(as_of: str, since: object, entries: object) -> dict:
    today = parse_date(as_of)
    first = _since(since, today)
    rows = []
    for e in _entries(entries):
        done = e.get("sorted")
        if not isinstance(done, bool):
            raise RuleError("invalid_entries")
        rows.append((parse_date(e.get("date")), done))
    met, skips = [], []
    for week in _complete_weeks(first, today):
        end = add_days(week, 6)
        mine = [done for d, done in rows if week <= d <= end]
        if not mine:
            skips.append(week.isoformat())
        elif all(mine):
            met.append(week.isoformat())
    return {"met": met, "skips": skips}


def on_time(dues: object, shown: object) -> dict:
    count = _int(shown, "invalid_amount")
    if not 1 <= count <= 52:
        raise RuleError("invalid_amount")
    if not isinstance(dues, list):
        raise RuleError("invalid_dues")
    rows = []
    for d in dues:
        if not isinstance(d, dict) or d.get("result") not in ("on_time", "missed", "unknown"):
            raise RuleError("invalid_dues")
        when = parse_date(d.get("due_date"))
        if d["result"] != "unknown":
            # Same day: a missed one sorts after an on-time one, so it breaks the run.
            rows.append((when, 1 if d["result"] == "missed" else 0, d["result"]))
    rows.sort()
    run = best = 0
    for _, _, result in rows:
        run = run + 1 if result == "on_time" else 0
        best = max(best, run)
    missed = [w for w, _, r in rows if r == "missed"]
    return {
        "current": run,
        "best": best,
        "checked": len(rows),
        "last_missed": missed[-1].isoformat() if missed else None,
        "shown": [{"due_date": w.isoformat(), "result": r} for w, _, r in rows[-count:]],
    }


def _bool(facts: dict, key: str) -> bool:
    value = facts.get(key)
    if not isinstance(value, bool):
        raise RuleError("invalid_facts")
    return value


def _opt(facts: dict, key: str) -> int | None:
    value = facts.get(key)
    return None if value is None else _int(value, "invalid_facts")


def _reached(raw: object, today: date) -> dict[str, date]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise RuleError("invalid_reached")
    out = {}
    for key, value in raw.items():
        when = parse_date(value)
        if when > today:
            raise RuleError("invalid_date")
        out[str(key)] = when
    return out


def _threshold(thresholds: object, key: str) -> int:
    if not isinstance(thresholds, dict):
        raise RuleError("invalid_thresholds")
    value = _int(thresholds.get(key), "invalid_thresholds")
    if value < 0:
        raise RuleError("invalid_thresholds")
    return value


def _path_facts(facts: object, thresholds: object) -> dict[str, dict]:
    """Each step's {met, have, need, clear} from the device's facts."""
    if not isinstance(facts, dict):
        raise RuleError("invalid_facts")
    parts = sum(_bool(facts, k) for k in ("pay_set", "budget_set", "balance_set"))
    own_cushion = _opt(facts, "cushion_cents")
    cushion = own_cushion if own_cushion else _threshold(thresholds, "cushion_cents")
    balance = _opt(facts, "balance_cents")
    starter = _threshold(thresholds, "starter_cents")
    saved = _int(facts.get("emergency_saved_cents"), "invalid_facts")
    months_need = _threshold(thresholds, "paid_in_full_months")
    has_cards = _bool(facts, "has_cards")
    months = _opt(facts, "paid_in_full_months")
    debts = _int(facts.get("debts_cents"), "invalid_facts")
    runway_need = _threshold(thresholds, "runway_tenths")
    runway = _opt(facts, "runway_tenths")
    later = _int(facts.get("later_cents"), "invalid_facts")
    return {
        "setup": {"met": parts == 3, "have": parts, "need": 3, "clear": False},
        "cushion": {
            "met": balance is not None and balance >= cushion,
            "have": balance,
            "need": cushion,
            "clear": False,
        },
        "starter": {"met": saved >= starter, "have": saved, "need": starter, "clear": False},
        "paid_in_full": {
            "met": (not has_cards) or (months is not None and months >= months_need),
            "have": months if has_cards else None,
            "need": months_need,
            "clear": not has_cards,
        },
        "debts": {"met": debts == 0, "have": debts, "need": 0, "clear": False},
        "three_months": {
            "met": runway is not None and runway >= runway_need,
            "have": runway,
            "need": runway_need,
            "clear": False,
        },
        "later": {"met": later > 0, "have": later, "need": 1, "clear": False},
    }


def path(
    as_of: str,
    facts: object,
    thresholds: object,
    reached: object = None,
    order: object = None,
    skipped: object = None,
) -> dict:
    today = parse_date(as_of)
    known = _reached(reached, today)
    steps = _path_facts(facts, thresholds)
    if order is not None and not isinstance(order, list):
        raise RuleError("invalid_order")
    if skipped is not None and not isinstance(skipped, list):
        raise RuleError("invalid_order")
    ordered: list[str] = []
    for sid in order or []:
        if sid in STEPS and sid not in ordered:
            ordered.append(sid)
    ordered += [s for s in STEPS if s not in ordered]
    skip = {s for s in (skipped or []) if s in STEPS}
    out = []
    newly = []
    current_found = False
    done = 0
    for sid in ordered:
        info = steps[sid]
        when = known.get(sid)
        if when is None and info["met"]:
            when = today
            newly.append(sid)
        if sid in skip:
            state = "skipped"
        elif when is not None:
            state = "done"
            done += 1
        elif not current_found:
            state = "current"
            current_found = True
        else:
            state = "next"
        out.append(
            {
                "id": sid,
                "state": state,
                "reached_on": when.isoformat() if when else None,
                "met_now": info["met"],
                "clear": info["clear"],
                "have": info["have"],
                "need": info["need"],
            }
        )
    return {
        "steps": out,
        "done": done,
        "total": len(STEPS) - len(skip),
        "current": next((s["id"] for s in out if s["state"] == "current"), None),
        "newly_reached": newly,
    }


def milestones(as_of: str, facts: object, thresholds: object, reached: object = None) -> dict:
    today = parse_date(as_of)
    known = _reached(reached, today)
    if not isinstance(facts, dict) or not isinstance(thresholds, dict):
        raise RuleError("invalid_facts")
    weeks = thresholds.get("streak_weeks")
    if not isinstance(weeks, list) or not weeks:
        raise RuleError("invalid_thresholds")
    weeks = [_int(n, "invalid_thresholds") for n in weeks]
    starter = _threshold(thresholds, "starter_cents")
    on_time_need = _threshold(thresholds, "on_time_payments")
    months_need = _threshold(thresholds, "paid_in_full_months")
    runway_need = _threshold(thresholds, "runway_tenths")
    jars_need = _threshold(thresholds, "jars_cents")

    jars = _int(facts.get("jars"), "invalid_facts")
    saved = _int(facts.get("emergency_saved_cents"), "invalid_facts")
    best_aside = _int(facts.get("best_set_aside"), "invalid_facts")
    kept_month = _int(facts.get("last_month_kept_cents"), "invalid_facts")
    best_on_time = _int(facts.get("best_on_time"), "invalid_facts")
    entries = _int(facts.get("entries"), "invalid_facts")
    to_sort = _int(facts.get("to_sort"), "invalid_facts")
    challenges = _int(facts.get("challenges_reached"), "invalid_facts")
    has_cards = _bool(facts, "has_cards")
    months = _opt(facts, "paid_in_full_months")
    listed = _bool(facts, "debts_listed")
    debts = _int(facts.get("debts_cents"), "invalid_facts")
    runway = _opt(facts, "runway_tenths")
    jar_cents = _int(facts.get("jars_saved_cents"), "invalid_facts")

    rows: list[tuple[str, bool, int | None, int]] = [
        ("first_jar", jars >= 1, jars, 1),
        ("starter_fund", saved >= starter, saved, starter),
    ]
    rows += [(f"streak_{n}", best_aside >= n, best_aside, n) for n in weeks]
    rows += [
        ("kept_month", kept_month > 0, kept_month, 1),
        (f"on_time_{on_time_need}", best_on_time >= on_time_need, best_on_time, on_time_need),
        ("all_sorted", entries >= 1 and to_sort == 0, to_sort, 0),
        ("challenge_done", challenges >= 1, challenges, 1),
        (
            "paid_in_full",
            has_cards and months is not None and months >= months_need,
            months,
            months_need,
        ),
        ("debts_gone", listed and debts == 0, debts, 0),
        ("three_months", runway is not None and runway >= runway_need, runway, runway_need),
        ("jars_total", jar_cents >= jars_need, jar_cents, jars_need),
    ]
    out = []
    newly = []
    for mid, met, have, need in rows:
        when = known.get(mid)
        if when is None and met:
            when = today
            newly.append(mid)
        out.append(
            {
                "id": mid,
                "reached_on": when.isoformat() if when else None,
                "have": have,
                "need": need,
            }
        )
    return {
        "milestones": out,
        "reached": sum(1 for m in out if m["reached_on"]),
        "newly_reached": newly,
    }
