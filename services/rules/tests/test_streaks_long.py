"""Streaks over long histories (November 20, 2026; invariant 94): the same cases as
packages/rules/src/streaks.long.test.ts, so both engines agree on a week, a month, a year, five
years, a year boundary and a leap February, and stay fast on years of entries."""

from __future__ import annotations

import time
from datetime import date, timedelta

from stackd_rules import streaks


def tuesdays(from_monday: str, to_monday: str, skip: tuple[str, ...] = ()) -> list[str]:
    out = []
    d = date.fromisoformat(from_monday)
    last = date.fromisoformat(to_monday)
    while d <= last:
        if d.isoformat() not in skip:
            out.append((d + timedelta(days=1)).isoformat())
        d += timedelta(days=7)
    return out


def every_day(start: str, days: int, per_day: int) -> list[dict]:
    d = date.fromisoformat(start)
    out = []
    for i in range(days):
        day = (d + timedelta(days=i)).isoformat()
        out += [
            {"date": day, "direction": "out", "amount_cents": 100, "sorted": True}
            for _ in range(per_day)
        ]
    return out


def test_after_one_week():
    s = streaks.weekly("2026-11-19", "2026-11-16", ["2026-11-17"], 2, 8)
    assert (s["current"], s["best"], s["this_week"], s["last_week"]) == (1, 1, "kept", None)


def test_after_a_month():
    s = streaks.weekly("2026-11-19", "2026-10-19", tuesdays("2026-10-19", "2026-11-16"), 2, 8)
    assert (s["current"], s["best"], s["kept_weeks"]) == (5, 5, 5)


def test_after_a_year_a_rest_week_holds():
    met = tuesdays("2025-11-17", "2026-11-16", ("2026-05-04",))
    s = streaks.weekly("2026-11-19", "2025-11-17", met, 2, 8, ["2026-05-04"])
    assert (s["current"], s["best"], s["kept_weeks"]) == (52, 52, 52)


def test_after_a_year_a_miss_restarts_the_run():
    met = tuesdays("2025-11-17", "2026-11-16", ("2026-05-04",))
    s = streaks.weekly("2026-11-19", "2025-11-17", met, 2, 8)
    assert (s["current"], s["best"]) == (28, 28)


def test_after_five_years():
    met = tuesdays("2021-11-22", "2026-11-16")
    s = streaks.weekly("2026-11-19", "2021-11-22", met, 2, 8)
    assert (s["current"], s["best"], len(met)) == (261, 261, 261)


def test_five_years_of_entries_stay_fast():
    entries = every_day("2021-11-22", 1824, 10)
    plans = [
        {"month": f"{y}-{m:02d}", "planned_cents": 10_000_000}
        for y in range(2021, 2027)
        for m in range(1, 13)
    ]
    t = time.perf_counter()
    under = streaks.under_plan("2026-11-19", "2021-11-22", plans, entries)
    under_s = time.perf_counter() - t
    t = time.perf_counter()
    done = streaks.sorted_weeks("2026-11-19", "2021-11-22", entries)
    sorted_s = time.perf_counter() - t
    assert len(under["met"]) == 260
    assert len(done["met"]) == 260
    assert under_s < 2 and sorted_s < 2


def test_a_week_across_new_year():
    r = streaks.under_plan(
        "2027-01-05",
        "2026-12-28",
        [{"month": "2027-01", "planned_cents": 31000}],
        [
            {"date": "2026-12-30", "direction": "out", "amount_cents": 99999},
            {"date": "2027-01-02", "direction": "out", "amount_cents": 3000},
        ],
    )
    assert r == {"met": ["2026-12-28"], "skips": []}


def test_a_leap_february():
    plans = [{"month": "2028-02", "planned_cents": 29000}]

    def at(cents: int) -> list[str]:
        rows = [{"date": "2028-02-27", "direction": "out", "amount_cents": cents}]
        return streaks.under_plan("2028-02-29", "2028-02-21", plans, rows)["met"]

    assert at(27000) == ["2028-02-21"]
    assert at(27001) == []
